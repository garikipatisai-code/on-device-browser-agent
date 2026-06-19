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
  // Reset module-level /g regexes — exec() leaves lastIndex non-zero when the loop
  // breaks early at `max`, which would corrupt the NEXT search in the same worker.
  RESULT_RE.lastIndex = 0;
  SNIPPET_RE.lastIndex = 0;
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

// A blocked / anti-bot response (an nginx 30x redirect stub, or the DuckDuckGo
// "anomaly" captcha challenge) rather than a results page. Lets us report a clear,
// honest "blocked" instead of the misleading "no results / page layout changed".
export function looksBlocked(html: string): boolean {
  if (!html.trim()) return true;
  if (/<title>\s*30\d\b/i.test(html)) return true; // 301/302 redirect stub
  return /anomaly-modal|challenge-form|bots use duckduckgo|error-lite@duckduckgo\.com|anomaly\.js/i.test(html);
}

// DuckDuckGo Lite results live in a table: result links carry class="result-link",
// snippets sit in <td class="result-snippet">. Best-effort — the captured /lite/ was
// a captcha, so this is unverified against live results markup.
const LITE_LINK_RE = /<a\b([^>]*\bclass=['"][^'"]*result-link[^'"]*['"][^>]*)>([\s\S]*?)<\/a>/gi;
const LITE_SNIPPET_RE = /<td[^>]*\bclass=['"][^'"]*result-snippet[^'"]*['"][^>]*>([\s\S]*?)<\/td>/gi;
const HREF_RE = /href=["']([^"']+)["']/i;

export function parseLiteResults(html: string, max = 10): SearchResult[] {
  const snippets: string[] = [];
  let m: RegExpExecArray | null;
  LITE_SNIPPET_RE.lastIndex = 0;
  while ((m = LITE_SNIPPET_RE.exec(html)) !== null) {
    snippets.push(stripHtml(m[1]).trim());
    if (snippets.length >= max) break;
  }
  const out: SearchResult[] = [];
  let i = 0;
  LITE_LINK_RE.lastIndex = 0;
  while ((m = LITE_LINK_RE.exec(html)) !== null) {
    const hrefM = m[1].match(HREF_RE);
    const url = hrefM ? decodeDdgUrl(hrefM[1]) : '';
    const title = stripHtml(m[2]).trim();
    if (!url || !title) continue;
    out.push({ title, url, snippet: snippets[i] ?? '' });
    i += 1;
    if (out.length >= max) break;
  }
  return out;
}

const SEARCH_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  accept: 'text/html',
  'accept-language': 'en-US,en;q=0.9',
};

interface SearchEndpoint {
  url: (q: string) => string;
  parse: (html: string, max?: number) => SearchResult[];
}

// Try the rich /html/ endpoint first, then fall back to /lite/ (a separate, simpler
// page that is sometimes reachable when /html/ is blocked).
const ENDPOINTS: SearchEndpoint[] = [
  { url: (q) => `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`, parse: parseDuckDuckGoResults },
  { url: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, parse: parseLiteResults },
];

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
    let blocked = false;
    for (const ep of ENDPOINTS) {
      let html: string | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const { signal, cleanup } = composeSignal(20_000, ctx.signal);
        try {
          const res = await fetch(ep.url(query), { signal, headers: SEARCH_HEADERS });
          if (!res.ok) {
            if (res.status >= 500) continue; // transient server error → retry once
            break; // 4xx → this endpoint is out
          }
          html = await res.text();
          break;
        } catch {
          continue; // network blip → retry once
        } finally {
          cleanup();
        }
      }
      if (html === null) continue; // unreachable after a retry → try the next endpoint
      if (looksBlocked(html)) {
        blocked = true;
        continue; // anti-bot page → try the next endpoint
      }
      const results = ep.parse(html, max ?? 10).filter((r) => !isAdUrl(r.url));
      if (results.length) {
        _lastResults = results;
        const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`);
        return {
          ok: true,
          content: `${lines.join('\n\n')}\n\n(To open one, call open_result with its number — e.g. {"index": 1}. Do NOT retype the URL.)`,
          data: { results: results as unknown as Record<string, unknown> },
        };
      }
      // reachable, not blocked, but 0 results → genuine empty here; try the next endpoint
    }
    if (blocked) {
      return {
        ok: false,
        content:
          'Web search is blocked right now: DuckDuckGo served a bot challenge/redirect on every endpoint. Try again later, or from a different network.',
      };
    }
    return { ok: false, content: 'No results found for that query.' };
  },
};
