import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { looksBlocked, parseLiteResults, searchTool } from '@/agent/tools/browser/search';
import type { ToolContext } from '@/agent/tools/registry';
// Real captured responses (both endpoints were blocking this network when captured).
import BLOCKED_HTML from '../fixtures/ddg-html-blocked.html?raw';
import CHALLENGE_LITE from '../fixtures/ddg-lite-challenge.html?raw';

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

  it('returns a clear "blocked" error (not "no results") when both endpoints are blocked', async () => {
    mockFetch((url) => (url.includes('/html/') ? { body: BLOCKED_HTML } : { body: CHALLENGE_LITE }));
    const res = await searchTool.dispatch({ query: 'wireless mouse' }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/block|challenge|bot/i);
    expect(res.content).not.toMatch(/no results/i);
  });
});
