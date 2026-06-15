// DuckDuckGo HTML scraper. No API key required.

import { z } from 'zod';
import type { ToolDefDescriptor } from '../registry';
import { composeSignal } from '@/background/signal';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const RESULT_RE = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
const SNIPPET_RE = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

export function parseDuckDuckGoResults(html: string, max = 10): SearchResult[] {
  const out: SearchResult[] = [];
  const snippets: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = SNIPPET_RE.exec(html)) !== null) {
    snippets.push(stripHtml(m[1]).trim());
    if (snippets.length >= max) break;
  }
  let i = 0;
  while ((m = RESULT_RE.exec(html)) !== null) {
    const rawHref = m[1];
    const title = stripHtml(m[2]).trim();
    const url = decodeDdgUrl(rawHref);
    if (!url || !title) continue;
    out.push({ title, url, snippet: snippets[i] ?? '' });
    i++;
    if (out.length >= max) break;
  }
  return out;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

function decodeDdgUrl(href: string): string {
  try {
    if (href.startsWith('//')) href = `https:${href}`;
    const u = new URL(href, 'https://duckduckgo.com');
    if (u.pathname === '/l/' && u.searchParams.has('uddg')) {
      return decodeURIComponent(u.searchParams.get('uddg')!);
    }
    return u.toString();
  } catch {
    return '';
  }
}

// DuckDuckGo sponsored results are redirector links (y.js → bing aclick), not real
// destinations — drop them so the model navigates to genuine result pages.
export function isAdUrl(url: string): boolean {
  return /duckduckgo\.com\/y\.js|bing\.com\/aclick|\/aclk\?/i.test(url);
}

// Most recent (ad-filtered) results, so open_result can navigate by number without
// the model ever retyping a URL (a small model kept hallucinating site paths).
let _lastResults: SearchResult[] = [];
export function getLastSearchResults(): SearchResult[] {
  return _lastResults;
}
// Cleared per task by the orchestrator so one task's results can't ground (or
// block) navigation in the next — the cache is module-level and would leak.
export function clearSearchResults(): void {
  _lastResults = [];
}

export const searchTool: ToolDefDescriptor<{ query: string; max?: number }> = {
  name: 'search',
  description: 'Web search via DuckDuckGo. Returns title, url, and snippet for each result.',
  argsSchema: z.object({
    query: z.string().min(1),
    max: z.number().int().min(1).max(20).optional(),
  }),
  async dispatch({ query, max }, ctx) {
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const { signal, cleanup } = composeSignal(20_000, ctx.signal);
    try {
      const res = await fetch(url, {
        signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          'accept': 'text/html',
          'accept-language': 'en-US,en;q=0.9',
        },
      });
      if (!res.ok) return { ok: false, content: `DuckDuckGo HTTP ${res.status}` };
      const html = await res.text();
      const results = parseDuckDuckGoResults(html, max ?? 10).filter((r) => !isAdUrl(r.url));
      if (!results.length) return { ok: false, content: 'No results parsed (page layout may have changed).' };
      _lastResults = results;
      const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`);
      return {
        ok: true,
        content: `${lines.join('\n\n')}\n\n(To open one, call open_result with its number — e.g. {"index": 1}. Do NOT retype the URL.)`,
        data: { results: results as unknown as Record<string, unknown> },
      };
    } finally {
      cleanup();
    }
  },
};
