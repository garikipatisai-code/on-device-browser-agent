// aria.extract — primary page reading channel. Stamps URL on every extraction.

import { z } from 'zod';
import type { ToolDefDescriptor, ToolResult } from '../registry';
import { withCdp, type SendCmd } from './lifecycle';
import { assignIndices, capTree, simplifyAxTree, type AxNode, type SimplifiedNode } from './aria';

interface CacheEntry {
  url: string;
  ts: number;
  byIndex: Map<number, number>;
  tree: SimplifiedNode;
}

const _cache = new Map<number, CacheEntry>();

export function getCachedExtraction(tabId: number): CacheEntry | undefined {
  return _cache.get(tabId);
}

export function clearExtractionCache(tabId?: number): void {
  if (tabId === undefined) _cache.clear();
  else _cache.delete(tabId);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Robustly fetch the full AX node list for a tab.
 * - Forces DOM computation (DOM.getDocument) so Chrome populates the a11y tree.
 * - Retries with a settle delay if the tree comes back as just the root
 *   (SPA hydration / lazy a11y computation).
 * Logs node counts so failures are diagnosable from the SW console.
 */
export async function getAxNodes(send: SendCmd): Promise<AxNode[]> {
  await send('DOM.enable').catch(() => undefined);
  await send('Accessibility.enable').catch(() => undefined);
  // Forcing a full DOM read often triggers the accessibility tree build.
  await send('DOM.getDocument', { depth: -1, pierce: true }).catch(() => undefined);

  let nodes: AxNode[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await send<{ nodes?: AxNode[] }>('Accessibility.getFullAXTree');
    nodes = res.nodes ?? [];
    console.log(`[BA] getFullAXTree attempt ${attempt}: ${nodes.length} nodes`);
    if (nodes.length > 1) break;
    await sleep(700); // give SPA content time to render, then retry
  }
  return nodes;
}

/** Read + simplify a tab's accessibility tree into the model-facing text (caches the index map
 *  for later clicks). Shared by aria.extract and tab.read_active so both behave identically. */
export async function extractAria(tabId: number): Promise<ToolResult> {
  // Fixed 12K-char window (NOT model-controlled — e4b kept starving itself by
  // passing tiny maxChars). capTree keeps the top of the page, where products
  // live, so the first ~10-15 land in the window without drowning the model.
  const cap = 12_000;
  const url = await new Promise<string>((resolve) =>
    chrome.tabs.get(tabId, (t) => resolve(t?.url ?? '')),
  );
  const ax = await withCdp(tabId, (send) => getAxNodes(send));
  const tree = simplifyAxTree(ax);
  const { byIndex } = assignIndices(tree);
  const { text, truncated } = capTree(tree, cap);
  _cache.set(tabId, { url, ts: Date.now(), byIndex, tree });
  // When the a11y tree is empty/near-root (canvas/JS-heavy or blocked pages),
  // steer the model to the visual fallback instead of re-extracting forever.
  const sparse = ax.length <= 1 || byIndex.size === 0;
  const hint = sparse
    ? '\n\n[NOTE: this page exposes almost no accessibility tree. Do NOT re-run aria.extract — call vision.read on this tab to read it visually.]'
    : '';
  return {
    ok: true,
    content: text + hint,
    data: { url, nodeCount: ax.length, interactiveCount: byIndex.size, truncated, sparse },
  };
}

export const ariaExtractTool: ToolDefDescriptor<{ tabId: number; maxChars?: number }> = {
  name: 'aria.extract',
  description:
    'Extract the simplified ARIA accessibility tree for a tab. Returns the indexed tree text for the model to read and interact with.',
  argsSchema: z.object({
    tabId: z.number().int(),
  }),
  dispatch: ({ tabId }) => extractAria(tabId),
};

export async function resolveBackendId(tabId: number, elementIndex: number): Promise<number> {
  const url = await new Promise<string>((resolve) =>
    chrome.tabs.get(tabId, (t) => resolve(t?.url ?? '')),
  );
  let entry = _cache.get(tabId);
  if (!entry || entry.url !== url) {
    const ax = await withCdp(tabId, (send) => getAxNodes(send));
    const tree = simplifyAxTree(ax);
    const { byIndex } = assignIndices(tree);
    entry = { url, ts: Date.now(), byIndex, tree };
    _cache.set(tabId, entry);
  }
  const id = entry.byIndex.get(elementIndex);
  if (!id) {
    throw new Error(
      `elementIndex ${elementIndex} not found. ${entry.byIndex.size} interactive elements on this page. Call aria.extract to refresh.`,
    );
  }
  return id;
}
