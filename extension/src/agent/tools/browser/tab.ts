// Tab management tools. Tab ownership tracked in hot state.
import { z } from 'zod';
import type { ToolContext, ToolDefDescriptor, ToolResult } from '../registry';
import { patchHot } from '@/background/state_store';
import { isBlockedUrl } from '@/agent/safety/domain_tiers';
import { getLastSearchResults } from './search';

async function waitForLoaded(tabId: number, timeoutMs: number): Promise<chrome.tabs.Tab> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = await new Promise<chrome.tabs.Tab | null>((resolve) => {
      try {
        chrome.tabs.get(tabId, (tab) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(tab);
        });
      } catch {
        resolve(null);
      }
    });
    if (t && t.status === 'complete') return t;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for tab ${tabId} to load`);
}

function normalizeUrl(u: string): string {
  return u.trim().replace(/[/]+$/, '');
}

/** True if `url` matches one of the results verbatim (modulo a trailing slash). */
export function urlIsFromResults(url: string, results: Array<{ url: string }>): boolean {
  const n = normalizeUrl(url);
  return results.some((r) => normalizeUrl(r.url) === n);
}

/** A bare homepage URL (no path) — can't be a fabricated deep path, so always safe. */
function isBareOrigin(url: string): boolean {
  try {
    const u = new URL(url);
    return u.pathname === '' || u.pathname === '/';
  } catch {
    return false;
  }
}

/**
 * tab.open grounding: block only FABRICATED deep paths. Allow anything when there
 * are no results to ground against, allow bare homepages (e.g. "go to amazon.com"),
 * and allow exact result URLs. Deep paths not in the results are rejected.
 */
export function openUrlAllowed(url: string, results: Array<{ url: string }>): boolean {
  if (!results.length) return true;
  if (isBareOrigin(url)) return true;
  return urlIsFromResults(url, results);
}

/** Open a tab at `url` and register ownership so the agent can close it later. */
export async function openOwnedTab(url: string, ctx: ToolContext): Promise<ToolResult> {
  if (isBlockedUrl(url)) return { ok: false, content: `Blocked URL: ${url}`, fatal: true };
  const tab = await new Promise<chrome.tabs.Tab>((resolve, reject) => {
    chrome.tabs.create({ url, active: false }, (t) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(t!);
    });
  });
  const tabId = tab.id!;
  const next = [...ctx.hot.ownedTabs, tabId];
  await patchHot({ ownedTabs: next });
  ctx.hot.ownedTabs = next;
  return { ok: true, content: `Opened tab ${tabId} at ${url}`, data: { tabId, url } };
}

export const tabOpenTool: ToolDefDescriptor<{ url: string }> = {
  name: 'tab.open',
  description:
    'Open a new tab at an EXACT URL copied from observed content. For SEARCH results use open_result instead — never retype a result URL.',
  argsSchema: z.object({ url: z.string().describe('Absolute URL, copied verbatim — never guessed.') }),
  async dispatch({ url }, ctx) {
    // Hard grounding: after a search, a small model keeps fabricating plausible
    // paths (e.g. Amazon zgbs URLs) that 404. Only allow URLs actually present in
    // the results; otherwise force the model onto open_result.
    const results = getLastSearchResults();
    if (!openUrlAllowed(url, results)) {
      return {
        ok: false,
        content:
          `"${url}" is not one of your search results — typed/guessed URLs 404. ` +
          `Open a result by number with open_result, e.g. {"index":1}. Results:\n` +
          results.map((r, i) => `${i + 1}. ${r.url}`).join('\n'),
      };
    }
    return openOwnedTab(url, ctx);
  },
};

export const openResultTool: ToolDefDescriptor<{ index: number }> = {
  name: 'open_result',
  description:
    'Open one of the most recent search results by its number (e.g. {"index":1}). Use this to navigate to a search result — never retype or guess its URL.',
  argsSchema: z.object({ index: z.number().int().positive() }),
  async dispatch({ index }, ctx) {
    const results = getLastSearchResults();
    if (!results.length) return { ok: false, content: 'No recent search results — call search first.' };
    const r = results[index - 1];
    if (!r) {
      return { ok: false, content: `No result #${index}. The last search returned ${results.length} results (use 1–${results.length}).` };
    }
    return openOwnedTab(r.url, ctx);
  },
};

export const tabCloseTool: ToolDefDescriptor<{ tabId: number }> = {
  name: 'tab.close',
  description: 'Close a tab the agent opened. Tabs you did not open cannot be closed.',
  argsSchema: z.object({ tabId: z.number().int() }),
  async dispatch({ tabId }, ctx) {
    if (!ctx.hot.ownedTabs.includes(tabId)) {
      return { ok: false, content: `Refusing: tab ${tabId} was not opened by the agent.` };
    }
    await new Promise<void>((resolve) => {
      chrome.tabs.remove(tabId, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
    const next = ctx.hot.ownedTabs.filter((id) => id !== tabId);
    await patchHot({ ownedTabs: next });
    ctx.hot.ownedTabs = next;
    return { ok: true, content: `Closed tab ${tabId}` };
  },
};

export const tabListTool: ToolDefDescriptor<{ reason: string }> = {
  name: 'tab.list',
  description: 'List all open tabs (id, url, title).',
  argsSchema: z.object({ reason: z.string().describe('Why you need the list.') }),
  async dispatch() {
    const tabs = await new Promise<chrome.tabs.Tab[]>((resolve) =>
      chrome.tabs.query({}, (t) => resolve(t)),
    );
    const lines = tabs.map((t) => `#${t.id} ${t.url ?? '(no url)'} — ${t.title ?? '(no title)'}`);
    return { ok: true, content: lines.join('\n'), data: { tabs: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title })) } };
  },
};

export const tabWaitLoadedTool: ToolDefDescriptor<{ tabId: number; timeoutMs?: number }> = {
  name: 'tab.wait_loaded',
  description: 'Wait for a tab to reach status "complete" (page fully loaded). Call after navigation.',
  argsSchema: z.object({
    tabId: z.number().int(),
    timeoutMs: z.number().int().min(100).max(60_000).optional(),
  }),
  async dispatch({ tabId, timeoutMs }) {
    const t = await waitForLoaded(tabId, timeoutMs ?? 15_000);
    return { ok: true, content: `Tab ${tabId} loaded: ${t.url}`, data: { url: t.url, title: t.title } };
  },
};

export const tabScreenshotTool: ToolDefDescriptor<{ tabId: number; format?: 'png' | 'jpeg' }> = {
  name: 'tab.screenshot',
  description: 'Capture a screenshot of the active tab as a data URI.',
  argsSchema: z.object({
    tabId: z.number().int(),
    format: z.enum(['png', 'jpeg']).optional(),
  }),
  async dispatch({ tabId, format }) {
    await new Promise<void>((resolve) => chrome.tabs.update(tabId, { active: true }, () => resolve()));
    const t = await new Promise<chrome.tabs.Tab>((resolve) =>
      chrome.tabs.get(tabId, (x) => resolve(x)),
    );
    const dataUri = await new Promise<string>((resolve, reject) => {
      chrome.tabs.captureVisibleTab(t.windowId, { format: format ?? 'png' }, (uri) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(uri);
      });
    });
    return {
      ok: true,
      content: `Captured tab ${tabId} (${dataUri.length} bytes)`,
      data: { dataUri, format: format ?? 'png' },
    };
  },
};
