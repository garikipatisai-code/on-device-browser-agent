// Tab management tools. Tab ownership tracked in hot state.
import { z } from 'zod';
import type { ToolContext, ToolDefDescriptor, ToolResult } from '../registry';
import { patchHot } from '@/background/state_store';
import { isBlockedUrl } from '@/agent/safety/domain_tiers';
import { getLastSearchResults } from './search';
import { extractAria } from './aria_tool';

/** Read the page in focus for the task: the most recent tab the AGENT opened (it knows the id),
 *  or — only when the agent hasn't opened anything — the page the USER is on (their active tab,
 *  the "ask this page" case). Read-only; never opens or closes a tab; the page stays on-device.
 *  Restricted active-tab URLs (chrome://, store, file) fail honestly. */
export const tabReadActiveTool: ToolDefDescriptor<{ reason?: string }> = {
  name: 'tab.read_active',
  description:
    "Read the page currently in focus: the most recent tab YOU opened, or — if you haven't opened any — the page the USER is looking at. Use it for any goal about the current/this page (summarize it, answer a question, check a claim). Read-only; does not open a new tab.",
  argsSchema: z.object({ reason: z.string().optional() }),
  async dispatch(_args, ctx) {
    // Mid-task the agent has already opened its own tab(s) and knows their ids — "this page" means
    // the page IT navigated to, NOT the user's active tab (which may be chrome://extensions or any
    // unrelated page). Prefer the most-recently-opened owned tab; fall back to the user's active
    // tab only when the agent owns nothing (the ask-this-page fast path).
    const owned = ctx.hot?.ownedTabs ?? [];
    if (owned.length > 0) {
      const tabId = owned[owned.length - 1];
      const res = await extractAria(tabId);
      const url = res.data && typeof res.data.url === 'string' ? res.data.url : undefined;
      return { ...res, data: { ...(res.data ?? {}), tabId, url } };
    }
    const tab = await new Promise<chrome.tabs.Tab | undefined>((resolve) =>
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0])),
    );
    if (!tab || typeof tab.id !== 'number') {
      return { ok: false, content: 'No active tab to read.' };
    }
    const url = tab.url ?? '';
    if (!/^https?:\/\//i.test(url)) {
      return {
        ok: false,
        content: `Can't read this page${url ? ` (${url})` : ''}. Open a normal web page (http/https) in the active tab, then try again.`,
      };
    }
    const res = await extractAria(tab.id);
    // Carry the tabId forward so a follow-on action (click/type) can target the same page.
    return { ...res, data: { ...(res.data ?? {}), tabId: tab.id, url } };
  },
};

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

/**
 * Condition-based settle: resolve as soon as the tab is loaded ('complete'), is
 * gone/not queryable (nothing to wait for), or the cap elapses. Never throws —
 * callers (e.g. the orchestrator's post-navigation auto-read) proceed regardless.
 * Replaces a fixed sleep: fast pages don't pay a flat delay, slow ones get more time.
 */
export async function waitForTabSettled(tabId: number, capMs = 5_000, pollMs = 150): Promise<void> {
  const start = Date.now();
  for (;;) {
    const status = await new Promise<string | null>((resolve) => {
      try {
        chrome.tabs.get(tabId, (t) => resolve(chrome.runtime?.lastError ? null : (t?.status ?? null)));
      } catch {
        resolve(null);
      }
    });
    if (status === 'complete' || status === null) return;
    if (Date.now() - start >= capMs) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
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

/** Open a tab at `url` and register ownership so the agent can close it later.
 *  Reuses an existing owned tab if one already points at this URL — prevents
 *  the model from creating N duplicate tabs for the same repo/page. */
export async function openOwnedTab(url: string, ctx: ToolContext): Promise<ToolResult> {
  if (isBlockedUrl(url)) return { ok: false, content: `Blocked URL: ${url}`, fatal: true };
  // Check existing owned tabs for a match before creating a new one
  for (const tid of ctx.hot.ownedTabs) {
    try {
      const t = await new Promise<chrome.tabs.Tab | null>((resolve) => chrome.tabs.get(tid, (tab) => resolve(chrome.runtime.lastError ? null : tab)));
      if (t && t.url && normalizeUrl(t.url) === normalizeUrl(url)) {
        return { ok: true, content: `Reused existing tab ${tid} at ${url}`, data: { tabId: tid, url } };
      }
    } catch { /* tab gone — skip */ }
  }
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
    'Open one of the most recent search results by its number (e.g. {"index":1} for the first result). Use this to navigate to a search result — never retype or guess its URL.',
  argsSchema: z.object({ index: z.number().int().min(0) }),
  async dispatch({ index }, ctx) {
    const results = getLastSearchResults();
    if (!results.length) return { ok: false, content: 'No recent search results — call search first.' };
    // Small models frequently pass a 0-based index for "the first result". Accept it as #1 rather
    // than rejecting the whole turn — this slip was wasting multiple turns per run re-trying 0→1.
    const n = index < 1 ? 1 : index;
    const r = results[n - 1];
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
