// Web search. Tries a fast server-side fetch of DuckDuckGo HTML; when that's anti-bot-blocked
// (it looks like a bot — no browser fingerprint/JS/cookies), falls back to opening the search in
// a REAL Google tab (full Chrome session — served without a CAPTCHA) and reading the rendered
// results via CDP. No API key.

import { z } from 'zod';
import type { ToolDefDescriptor } from '../registry';
import { composeSignal } from '@/background/signal';
import { withCdp } from './lifecycle';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  }
  let pos = 0; // index of the current result LINK — snippets are positional, not per-kept
  while ((m = RESULT_RE.exec(html)) !== null) {
    const snippet = snippets[pos] ?? '';
    pos += 1;
    const title = stripHtml(m[2]).trim();
    const url = decodeDdgUrl(m[1]);
    if (!url || !title) continue;
    out.push({ title, url, snippet });
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
  // A 30x redirect stub is a tiny body; a real page that merely starts its <title>
  // with "302..." is large — only treat the title prefix as a block on a tiny body.
  if (html.length < 1024 && /<title>\s*30\d\b/i.test(html)) return true;
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

function formatResults(results: SearchResult[]): string {
  const lines = results.map(
    (r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`,
  );
  return `${lines.join('\n\n')}\n\n(To open one, call open_result with its number — e.g. {"index": 1}. Do NOT retype the URL.)`;
}

// A search engine's own host (nav/footer/logo links on the results page) — not a real result.
const ENGINE_HOST_RE = /(^|\.)(duckduckgo\.com|bing\.com|google\.[a-z.]+|googleusercontent\.com|microsoft\.com)$/i;
function isEngineInternal(url: string): boolean {
  try {
    return ENGINE_HOST_RE.test(new URL(url).hostname);
  } catch {
    return true;
  }
}

/** Clean the raw {title,url} anchors scraped from a rendered results page into real results:
 *  decode DDG redirects, drop ads + the engine's own nav links + dupes, cap. Pure + testable —
 *  the (live-only) DOM scraping feeds this; this is where the logic lives. */
export function parseTabResults(json: string, max = 10): SearchResult[] {
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    const title = String((r as { title?: unknown }).title ?? '').trim();
    let url = String((r as { url?: unknown }).url ?? '').trim();
    if (!title || !url) continue;
    url = decodeDdgUrl(url) || url; // a uddg redirect that slipped through → real destination
    // Google sometimes wraps organic results in /url?q=<dest> — unwrap to the real destination.
    try {
      const u = new URL(url);
      if (/(^|\.)google\./i.test(u.hostname) && u.pathname === '/url' && u.searchParams.get('q')) {
        url = u.searchParams.get('q') as string;
      }
    } catch {
      continue;
    }
    if (isAdUrl(url) || isEngineInternal(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ title: title.slice(0, 200), url, snippet: '' });
    if (out.length >= max) break;
  }
  return out;
}

// Runs IN the results page (via CDP Runtime.evaluate). Collects candidate result anchors —
// known per-engine selectors first (Google's title is an <h3> inside the result <a>), then a
// generic "external link with real text" fallback — and hands them to parseTabResults. Defensive.
const EXTRACT_JS = `(function(){
  try{
    var sels=['#search a:has(h3)','#rso a:has(h3)','div.yuRUbf>a','a[data-testid="result-title-a"]','a.result__a','#links a.result__a','li.b_algo h2 a'];
    var list=[];
    for(var i=0;i<sels.length;i++){var g;try{g=document.querySelectorAll(sels[i]);}catch(e){g=[];}if(g&&g.length){list=Array.prototype.slice.call(g);break;}}
    if(!list.length){
      list=Array.prototype.slice.call(document.querySelectorAll('a[href^="http"]')).filter(function(a){return (a.textContent||'').trim().length>15;});
    }
    var out=[];
    for(var j=0;j<list.length&&out.length<40;j++){
      var el=list[j];var a=el.tagName==='A'?el:(el.closest?el.closest('a'):null);
      if(!a||!a.href)continue;
      var h3=a.querySelector?a.querySelector('h3'):null;
      var title=((h3&&h3.textContent)||a.textContent||'').replace(/\\s+/g,' ').trim();
      out.push({title:title,url:a.href});
    }
    return JSON.stringify(out);
  }catch(e){return '[]';}
})()`;

async function waitForComplete(tabId: number, signal?: AbortSignal, capMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < capMs) {
    if (signal?.aborted) return;
    const status = await new Promise<string>((resolve) =>
      chrome.tabs.get(tabId, (t) => {
        void chrome.runtime?.lastError;
        resolve(t?.status ?? 'complete');
      }),
    );
    if (status === 'complete') break;
    await sleep(200);
  }
  await sleep(700); // SPA results paint shortly after 'complete'
}

/** The "use a real browser" path: open the search in a background tab (full Chrome — a real
 *  session, so Google serves results without a bot CAPTCHA), read the rendered results via CDP,
 *  then close the tab. Only the query leaves the device (inherent to any web search). */
async function searchViaTab(query: string, max: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`;
  const tab = await new Promise<chrome.tabs.Tab | null>((resolve) =>
    chrome.tabs.create({ url, active: false }, (t) => {
      void chrome.runtime?.lastError;
      resolve(t ?? null);
    }),
  );
  const tabId = tab?.id;
  if (typeof tabId !== 'number') return [];
  try {
    await waitForComplete(tabId, signal);
    if (signal?.aborted) return [];
    const json = await withCdp(tabId, async (send) => {
      const r = await send<{ result?: { value?: string } }>('Runtime.evaluate', {
        expression: EXTRACT_JS,
        returnByValue: true,
      });
      return typeof r?.result?.value === 'string' ? r.result.value : '[]';
    });
    return parseTabResults(json, max);
  } finally {
    chrome.tabs.remove(tabId, () => void chrome.runtime?.lastError);
  }
}

export const searchTool: ToolDefDescriptor<{ query: string; max?: number }> = {
  name: 'search',
  description:
    'Web search. Returns a numbered list of results (title + url). No API key — it reads a real search-results page. Open a result by number with open_result.',
  argsSchema: z.object({
    query: z.string().min(1),
    max: z.number().int().min(1).max(20).optional(),
  }),
  async dispatch({ query, max }, ctx) {
    let blocked = false;
    let reachable = false; // got an HTTP body from at least one endpoint (vs. all-unreachable)
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
        } catch (err) {
          if (ctx.signal?.aborted) throw err; // user aborted — propagate, don't swallow + retry
          continue; // network blip → retry once
        } finally {
          cleanup();
        }
      }
      if (html === null) continue; // unreachable after a retry → try the next endpoint
      reachable = true;
      if (looksBlocked(html)) {
        blocked = true;
        continue; // anti-bot page → try the next endpoint
      }
      const results = ep.parse(html, max ?? 10).filter((r) => !isAdUrl(r.url));
      if (results.length) {
        _lastResults = results;
        return {
          ok: true,
          content: formatResults(results),
          data: { results: results as unknown as Record<string, unknown> },
        };
      }
      // reachable, not blocked, but 0 results → genuine empty here; try the next endpoint
    }

    // The quick fetch was blocked / unreachable / empty. Fall back to what a human does: open the
    // search in a REAL Google tab (full Chrome session, so it's served without a bot CAPTCHA) and
    // read the rendered results via CDP. Keyless; reuses our tab + accessibility machinery.
    try {
      const viaTab = await searchViaTab(query, max ?? 10, ctx.signal);
      if (viaTab.length) {
        _lastResults = viaTab;
        return {
          ok: true,
          content: formatResults(viaTab),
          data: { results: viaTab as unknown as Record<string, unknown> },
        };
      }
    } catch (err) {
      if (ctx.signal?.aborted) throw err; // propagate a user abort
    }

    if (blocked) {
      return {
        ok: false,
        content:
          'Web search is blocked right now — the quick fetch was bot-challenged, and reading Google in a real tab returned nothing usable (it may be a consent wall). Try again, or search manually in a tab.',
      };
    }
    if (!reachable) {
      return {
        ok: false,
        content:
          'Could not reach a search engine (network error/timeout) — even opening the results in a tab returned nothing. This does NOT mean the query has no results; check the connection.',
      };
    }
    return { ok: false, content: 'No results found for that query.' };
  },
};
