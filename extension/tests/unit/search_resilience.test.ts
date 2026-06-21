import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { looksBlocked, parseLiteResults, parseTabResults, searchTool } from '@/agent/tools/browser/search';
import type { ToolContext } from '@/agent/tools/registry';
// Real captured responses (both endpoints were blocking this network when captured).
import BLOCKED_HTML from '../fixtures/ddg-html-blocked.html?raw';
import CHALLENGE_LITE from '../fixtures/ddg-lite-challenge.html?raw';

// Stub the real-tab fallback's deps (tabs + CDP) so dispatch can reach it without a real browser:
// the in-page scrape returns `evalJson`, which parseTabResults then cleans. Returns a restore fn.
function stubSearchTab(evalJson: string) {
  const od = chrome.debugger;
  const oc = chrome.tabs.create;
  const og = chrome.tabs.get;
  const orm = chrome.tabs.remove;
  chrome.tabs.create = ((_o: unknown, cb: (t: unknown) => void) => cb({ id: 4242, status: 'complete' })) as unknown as typeof chrome.tabs.create;
  chrome.tabs.get = ((_id: number, cb: (t: unknown) => void) => cb({ id: 4242, status: 'complete' })) as unknown as typeof chrome.tabs.get;
  chrome.tabs.remove = ((_id: number, cb: () => void) => cb()) as unknown as typeof chrome.tabs.remove;
  chrome.debugger = {
    attach: (_t: unknown, _v: unknown, cb: () => void) => cb(),
    detach: (_t: unknown, cb: () => void) => cb(),
    sendCommand: (_t: unknown, method: string, _p: unknown, cb: (r?: unknown) => void) =>
      cb(method === 'Runtime.evaluate' ? { result: { value: evalJson } } : {}),
  } as unknown as typeof chrome.debugger;
  return () => {
    chrome.debugger = od;
    chrome.tabs.create = oc;
    chrome.tabs.get = og;
    chrome.tabs.remove = orm;
  };
}

describe('parseTabResults — clean scraped result anchors', () => {
  it('drops engine-internal nav, ads, dupes; decodes DDG redirects; caps', () => {
    const raw = JSON.stringify([
      { title: 'DuckDuckGo', url: 'https://duckduckgo.com/about' }, // engine nav → drop
      { title: 'Real Result', url: 'https://example.com/a' },
      { title: 'Dup', url: 'https://example.com/a' }, // dupe → drop
      { title: 'Via redirect', url: 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb' }, // decode
      { title: 'Ad', url: 'https://duckduckgo.com/y.js?ad=1' }, // ad → drop
      { title: '', url: 'https://example.net/x' }, // no title → drop
    ]);
    const r = parseTabResults(raw, 10);
    expect(r.map((x) => x.url)).toEqual(['https://example.com/a', 'https://example.org/b']);
  });

  it('returns [] on malformed / non-array JSON', () => {
    expect(parseTabResults('not json')).toEqual([]);
    expect(parseTabResults('{"a":1}')).toEqual([]);
  });
});

describe('looksBlocked (real captured fixtures)', () => {
  it('flags the /html/ 302 redirect stub', () => {
    expect(looksBlocked(BLOCKED_HTML)).toBe(true);
  });
  it('flags the /lite/ anomaly captcha challenge', () => {
    expect(looksBlocked(CHALLENGE_LITE)).toBe(true);
  });
  it('does NOT flag a normal results page', () => {
    expect(looksBlocked('<html><body><a class="result__a" href="x">A result</a></body></html>')).toBe(false);
  });
  it('does NOT flag a large content page whose <title> merely starts with 30x', () => {
    const big = `<html><head><title>302 Found Mice</title></head><body>${'<a class="result__a" href="x">r</a>'.repeat(60)}</body></html>`;
    expect(looksBlocked(big)).toBe(false);
  });
});

// Synthetic /lite/ results in the documented table layout. The captured /lite/ was a
// captcha, so this is best-effort and unverified against live results.
const LITE_RESULTS = `
<table>
 <tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa" class='result-link'>Alpha result</a></td></tr>
 <tr><td class='result-snippet'>Alpha snippet text.</td></tr>
 <tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb" class='result-link'>Beta result</a></td></tr>
 <tr><td class='result-snippet'>Beta snippet text.</td></tr>
</table>`;

describe('parseLiteResults (best-effort, documented format)', () => {
  it('extracts title, decoded url, and snippet from the lite table layout', () => {
    const r = parseLiteResults(LITE_RESULTS, 10);
    expect(r.length).toBeGreaterThanOrEqual(2);
    expect(r[0].title).toBe('Alpha result');
    expect(r[0].url).toBe('https://example.com/a');
    expect(r[0].snippet).toContain('Alpha snippet');
  });
});

describe('searchTool dispatch — fallback + honest block error', () => {
  const ctx = () => ({ signal: undefined }) as unknown as ToolContext;
  let origFetch: typeof globalThis.fetch;
  beforeEach(() => {
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  function mockFetch(map: (url: string) => { ok?: boolean; status?: number; body: string }) {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const { ok = true, status = 200, body } = map(url);
      return { ok, status, text: async () => body } as Response;
    }) as typeof globalThis.fetch;
  }

  it('falls back to /lite/ when /html/ is blocked', async () => {
    mockFetch((url) => (url.includes('/html/') ? { body: BLOCKED_HTML } : { body: LITE_RESULTS }));
    const res = await searchTool.dispatch({ query: 'wireless mouse' }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toContain('Alpha result');
  });

  it('returns a clear "blocked" error (not "no results") when fetch is blocked AND the tab finds nothing', async () => {
    mockFetch((url) => (url.includes('/html/') ? { body: BLOCKED_HTML } : { body: CHALLENGE_LITE }));
    const restore = stubSearchTab('[]');
    const res = await searchTool.dispatch({ query: 'wireless mouse' }, ctx());
    restore();
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/block|challenge|bot/i);
    expect(res.content).not.toMatch(/no results/i);
  });

  it('falls back to a REAL browser tab and returns the rendered results when the fetch is blocked', async () => {
    mockFetch((url) => (url.includes('/html/') ? { body: BLOCKED_HTML } : { body: CHALLENGE_LITE }));
    const restore = stubSearchTab(
      JSON.stringify([{ title: 'Wireless Mouse — Best Buy', url: 'https://bestbuy.com/mouse' }]),
    );
    const res = await searchTool.dispatch({ query: 'wireless mouse' }, ctx());
    restore();
    expect(res.ok).toBe(true);
    expect(res.content).toContain('Wireless Mouse — Best Buy');
    expect(res.content).toContain('bestbuy.com/mouse');
  });
});

describe('searchTool dispatch — network failure vs genuine empty vs abort', () => {
  let origFetch: typeof globalThis.fetch;
  beforeEach(() => {
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });
  const ctx = (signal?: AbortSignal) => ({ signal }) as unknown as ToolContext;

  it('reports a network/unreachable error (not "no results") when every endpoint fails', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof globalThis.fetch;
    const restore = stubSearchTab('[]');
    const res = await searchTool.dispatch({ query: 'wireless mouse' }, ctx());
    restore();
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/reach|network|timeout|unreachable/i);
    expect(res.content).not.toMatch(/no results found/i);
  });

  it('still reports "no results" when an endpoint responds but parses empty (genuine zero hits)', async () => {
    const emptyPage = `<html><body>${'x'.repeat(1100)}</body></html>`;
    globalThis.fetch = (async () => ({ ok: true, status: 200, text: async () => emptyPage }) as Response) as typeof globalThis.fetch;
    const restore = stubSearchTab('[]');
    const res = await searchTool.dispatch({ query: 'zxqwerty no such thing' }, ctx());
    restore();
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/no results/i);
  });

  it('propagates a user abort instead of swallowing it and trying the next endpoint', async () => {
    const ac = new AbortController();
    ac.abort();
    globalThis.fetch = (async () => {
      throw new DOMException('Aborted', 'AbortError');
    }) as typeof globalThis.fetch;
    await expect(searchTool.dispatch({ query: 'x' }, ctx(ac.signal))).rejects.toThrow();
  });
});
