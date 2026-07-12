// Page-level tools: DOM query, wait for selector, fetch API, click by selector.
// These bridge the gap between ARIA-tree-only perception and full browser capability:
// SPAs, JS-rendered content, dynamic loading, API queries.

import { z } from 'zod';
import type { ToolDefDescriptor, ToolContext } from '../registry';
import { withCdp } from './lifecycle';
import { assertCanAct, isBlockedUrl } from '@/agent/safety/domain_tiers';
import { clearExtractionCache } from './aria_tool';

/** SSRF guard — reject URLs targeting internal/private addresses.
 *  page.fetch runs in the extension service worker with privileged network access,
 *  so it must not be used to probe internal services. Block private IP ranges
 *  and loopback addresses by hostname pattern (no DNS resolution needed at this layer). */
const PRIVATE_HOST_RE = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|0\.0\.0\.0|\[::1\]|\[f[cd][\da-f]{2}:)/i;

function isPrivateTarget(url: string): boolean {
  try {
    const u = new URL(url);
    return PRIVATE_HOST_RE.test(u.hostname) || u.hostname.endsWith('.internal') || u.hostname.endsWith('.local');
  } catch {
    return true; // invalid URL → treat as unsafe
  }
}

// ── dom.query ─────────────────────────────────────────────
// Query the rendered DOM by CSS selector. When called without a selector
// returns the full visible page text — this is the primary way to read
// content that JS rendered but the ARIA tree missed (SPAs, tables, lists).

const DOM_QUERY_FN = `function(selector, maxResults) {
  // Wait a tiny tick for any pending render before snapshotting
  var nodes;
  if (!selector) {
    // Full page snapshot: capture structured visible text
    var body = document.body;
    if (!body) return "<no body>";
    var text = body.innerText || body.textContent || "";
    return text.substring(0, 30000);
  }
  try { nodes = document.querySelectorAll(selector); } catch(e) { return "<invalid selector: " + e.message + ">"; }
  var out = [];
  var limit = typeof maxResults === 'number' ? Math.min(maxResults, 100) : 50;
  for (var i = 0; i < nodes.length && i < limit; i++) {
    var el = nodes[i];
    var style = window.getComputedStyle(el);
    var visible = style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
    var text = (el.textContent || '').trim().substring(0, 2000);
    var href = el.getAttribute && el.getAttribute('href');
    if (href) href = href.substring(0, 500);
    out.push({
      tag: (el.tagName || '').toLowerCase(),
      text: text,
      visible: visible,
      href: href || undefined,
      id: el.getAttribute ? el.getAttribute('id') || undefined : undefined,
      class: el.getAttribute ? (el.getAttribute('class') || '').substring(0, 100) || undefined : undefined,
    });
  }
  return out;
}`;

export const domQueryTool: ToolDefDescriptor<{ tabId: number; selector?: string; maxResults?: number }> = {
  name: 'dom.query',
  description:
    'Query the rendered DOM of a page. Without selector: returns all visible text on the page (captures JS-rendered content the ARIA tree may miss). With selector: returns matching elements with their text, tag, visibility, and href. Use this for tables, lists, dynamically loaded content, or any page where aria.extract returns sparse results. Requires click-only tier.',
  argsSchema: z.object({
    tabId: z.number().int().describe('Target tab ID'),
    selector: z.string().optional().describe('CSS selector (e.g. "table", ".results", "#main"). Omit to return full page text.'),
    maxResults: z.number().int().min(1).max(100).optional().describe('Max elements to return when using a selector (default 50)'),
  }),
  async dispatch({ tabId, selector, maxResults }, ctx) {
    const url = await new Promise<string>((resolve) => chrome.tabs.get(tabId, (t) => resolve(t?.url ?? '')));
    assertCanAct(url, 'click-only', ctx.settings.domainTiers, ctx.settings.bypassDomainTiers);
    if (isBlockedUrl(url)) {
      return { ok: false, content: `Cannot query DOM on this URL (blocked protocol).` };
    }
    const result = await withCdp(tabId, async (send) => {
      await send('Runtime.enable');
      const { result: res } = await send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
        expression: `(${DOM_QUERY_FN})(${JSON.stringify(selector ?? null)}, ${JSON.stringify(maxResults ?? null)})`,
        returnByValue: true,
        awaitPromise: false,
      });
      return res?.value;
    });
    if (!result) return { ok: false, content: 'DOM query returned no result (page may be empty or blocked).' };
    if (typeof result === 'string') return { ok: true, content: result };
    if (Array.isArray(result)) {
      if (result.length === 0) return { ok: true, content: 'No elements matched that selector.' };
      const lines = result.map((el: Record<string, unknown>, i: number) => {
        const tag = String(el.tag || el.tagName || '?');
        const text = String(el.text || '').substring(0, 300);
        const href = el.href ? ` → ${el.href}` : '';
        const visible = el.visible ? '' : ' [hidden]';
        return `  [${i + 1}] <${tag}>${visible}: ${text}${href}`;
      });
      return { ok: true, content: `Found ${result.length} elements:\n${lines.join('\n')}` };
    }
    return { ok: true, content: JSON.stringify(result).substring(0, 10000) };
  },
};

// ── dom.click_selector ─────────────────────────────────────
// Click an element by CSS selector. Use when an element isn't indexed in
// the ARIA tree (JS-rendered menus, shadow roots, dynamic content).

const CLICK_SELECTOR_FN = `function(selector) {
  var el;
  try { el = document.querySelector(selector); } catch(e) { return "<invalid selector>"; }
  if (!el) return "<not found>";
  el.scrollIntoView({block:'center', behavior:'instant'});
  el.focus();
  var tag = (el.tagName || '').toLowerCase();
  var text = (el.textContent || '').trim().substring(0, 100);
  el.click();
  return JSON.stringify({tag:tag, text:text});
}`;

export const domClickSelectorTool: ToolDefDescriptor<{ tabId: number; selector: string }> = {
  name: 'dom.click_selector',
  description:
    'Click an element by CSS selector. Use when the element is not indexed in the ARIA tree (JS-rendered menus, SPAs, shadow DOM) or when you already know the selector from dom.query. Requires click-only tier.',
  argsSchema: z.object({
    tabId: z.number().int().describe('Target tab ID'),
    selector: z.string().describe('CSS selector for the element to click (e.g. "button.submit", "[data-testid=\\"search\\"]")'),
  }),
  async dispatch({ tabId, selector }, ctx) {
    const url = await new Promise<string>((resolve) => chrome.tabs.get(tabId, (t) => resolve(t?.url ?? '')));
    assertCanAct(url, 'click-only', ctx.settings.domainTiers, ctx.settings.bypassDomainTiers);
    const result = await withCdp(tabId, async (send) => {
      await send('Runtime.enable');
      const { result: res } = await send<{ result?: { value?: string } }>('Runtime.evaluate', {
        expression: `(${CLICK_SELECTOR_FN})(${JSON.stringify(selector)})`,
        returnByValue: true,
        awaitPromise: false,
      });
      return res?.value;
    });
    if (!result) return { ok: false, content: `Click by selector "${selector}" returned no result.` };
    clearExtractionCache(tabId);
    if (result.startsWith('<')) return { ok: false, content: `Element not found for selector "${selector}".` };
    return { ok: true, content: `Clicked <${result}> via selector "${selector}"` };
  },
};

// ── page.wait_for ──────────────────────────────────────────
// Poll the DOM until a CSS selector appears. Essential for SPAs
// that render content after JS execution / API calls.

const WAIT_FOR_FN = `function(selector, timeoutMs) {
  var deadline = Date.now() + timeoutMs;
  return new Promise(function(resolve) {
    function poll() {
      if (typeof document === 'undefined') { resolve({found:false, reason:'no document'}); return; }
      try {
        var el = document.querySelector(selector);
        if (el) {
          var text = (el.textContent || '').trim().substring(0, 3000);
          var tag = el.tagName ? el.tagName.toLowerCase() : '';
          resolve({found:true, tag:tag, text:text, html:el.innerHTML ? el.innerHTML.substring(0,1000) : ''});
          return;
        }
      } catch(e) { /* ignore */ }
      if (Date.now() >= deadline) { resolve({found:false, reason:'timeout'}); return; }
      setTimeout(poll, 200);
    }
    poll();
  });
}`;

export const pageWaitForTool: ToolDefDescriptor<{ tabId: number; selector: string; timeoutMs?: number }> = {
  name: 'page.wait_for',
  description:
    'Wait for an element matching a CSS selector to appear in the DOM (polls every 200ms). Use after navigating to a page that loads content dynamically (search results, SPA, infinite scroll). Returns the element text once found, or confirms it was already there. If the element does not appear within the timeout, reports failure — the page may have loaded differently.',
  argsSchema: z.object({
    tabId: z.number().int().describe('Target tab ID'),
    selector: z.string().describe('CSS selector to wait for (e.g. ".search-results", "[data-loaded=true]", "table")'),
    timeoutMs: z.number().int().min(1000).max(60000).optional().describe('Max wait time in ms (default 15000)'),
  }),
  async dispatch({ tabId, selector, timeoutMs }) {
    const timeout = timeoutMs ?? 15000;
    const result = await withCdp(tabId, async (send) => {
      await send('Runtime.enable');
      const { result: res } = await send<{ result?: { value?: { found?: boolean; tag?: string; text?: string; reason?: string } } }>('Runtime.evaluate', {
        expression: `(${WAIT_FOR_FN})(${JSON.stringify(selector)}, ${timeout})`,
        returnByValue: true,
        awaitPromise: true,
      });
      return res?.value;
    });
    if (!result || !result.found) {
      return { ok: false, content: `Timed out waiting for "${selector}" (${timeout}ms). The page may not have loaded expected content. Try tab.screenshot to see what's visible.` };
    }
    const tag = result.tag ?? '?';
    const text = result.text ? ` Text: ${result.text.substring(0, 500)}` : '';
    return { ok: true, content: `Element "${selector}" (<${tag}>) appeared.${text}` };
  },
};

// ── page.fetch ─────────────────────────────────────────────
// Make HTTP requests from extension context. Extensions bypass CORS,
// so this can query any REST API directly. Runs in the service worker,
// not the page — no CSRF risks.

export const pageFetchTool: ToolDefDescriptor<{
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}> = {
  name: 'page.fetch',
  description:
    'Make an HTTP request from the extension context. Runs in the background service worker (not in-page), so CORS does not apply — you can query REST APIs directly. Use this for fetching JSON data, checking APIs, or getting structured data that would require a page load otherwise. Returns the response body (up to 50KB).',
  argsSchema: z.object({
    url: z.string().url().describe('Full URL to fetch'),
    method: z.string().optional().describe('HTTP method (default GET)'),
    headers: z.record(z.string(), z.string()).optional().describe('Request headers as key-value pairs'),
    body: z.string().optional().describe('Request body for POST/PUT/PATCH'),
  }),
  async dispatch({ url, method = 'GET', headers, body }, ctx) {
    if (isBlockedUrl(url)) {
      return { ok: false, content: `Cannot fetch blocked protocol URL.` };
    }
    if (isPrivateTarget(url)) {
      return { ok: false, content: `SSRF guard: cannot fetch private/internal URL (${new URL(url).hostname}). page.fetch is for external REST APIs only.` };
    }
    // Apply domain-tier restrictions — page.fetch is a write-level action
    try { assertCanAct(url, 'click-only', ctx.settings.domainTiers, ctx.settings.bypassDomainTiers); } catch { return { ok: false, content: `Domain tier blocks fetch to this host.` }; }
    try {
      const response = await fetch(url, {
        method,
        headers: { ...headers },
        body: method !== 'GET' && method !== 'HEAD' && body ? body : undefined,
      });
      const ct = response.headers.get('content-type') || '';
      const isJson = ct.includes('json') || ct.includes('javascript');
      const text = isJson ? JSON.stringify(await response.json(), null, 2) : await response.text();
      const truncated = text.length > 50000 ? text.substring(0, 50000) + '\n... [truncated at 50KB]' : text;
      return {
        ok: response.ok,
        content: `HTTP ${response.status} ${response.statusText}\n\n${truncated}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, content: `Fetch failed: ${msg}` };
    }
  },
};

// ── page.expect ─────────────────────────────────────────────
// Deterministic postcondition checkpoint: run a JS expression against the page
// and verify it evaluates to true. Use after an action to catch failures fast
// without waiting for the expensive LLM evaluator.
//
// NOTE: uses eval() in the PAGE context via CDP Runtime.evaluate. This is safe
// because: (1) the page JS realm is already fully accessible through CDP (any
// Runtime.evaluate call has the same reach), (2) the expression runs in-page,
// not in the extension's privileged service-worker context, (3) the agent can
// already do everything CDP allows — this doesn't add new capabilities,
// just formalizes a common check.

const EXPECT_FN = `function(expr) { try { return !!eval(expr); } catch(e) { return "<error: " + e.message + ">"; } }`;

export const pageExpectTool: ToolDefDescriptor<{ tabId: number; expression: string; description?: string }> = {
  name: 'page.expect',
  description:
    'Run a JavaScript expression against the page and verify it returns true. Use after a click/type/navigation to confirm the expected change happened — a deterministic check that catches failures instantly (no LLM evaluator wait). The expression runs in the page context and must evaluate to boolean. Examples: "document.querySelector(\'.search-results\') !== null", "document.title.includes(\'Results\')", "document.querySelector(\'#price\').innerText.includes(\'$29\')". Returns pass/fail and the actual value.',
  argsSchema: z.object({
    tabId: z.number().int().describe('Target tab ID'),
    expression: z.string().describe('A JavaScript expression that evaluates to true (pass) or false (fail). Runs via eval() in page context.'),
    description: z.string().optional().describe('What you expect (for logging). E.g. "search results appeared"'),
  }),
  async dispatch({ tabId, expression, description }, ctx) {
    const url = await new Promise<string>((resolve) => chrome.tabs.get(tabId, (t) => resolve(t?.url ?? '')));
    assertCanAct(url, 'click-only', ctx.settings.domainTiers, ctx.settings.bypassDomainTiers);
    const result = await withCdp(tabId, async (send) => {
      await send('Runtime.enable');
      const { result: res } = await send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
        expression: `(${EXPECT_FN})(${JSON.stringify(expression)})`,
        returnByValue: true,
        awaitPromise: false,
      });
      return res?.value;
    });
    const desc = description ? ` (${description})` : '';
    if (typeof result === 'string' && result.startsWith('<error')) {
      return { ok: false, content: `page.expect JS error${desc}: ${result}` };
    }
    const passed = result === true;
    return {
      ok: passed,
      content: passed
        ? `✓ Check passed${desc}: ${expression}`
        : `✗ Check failed${desc}: ${expression} → got ${JSON.stringify(result)}`,
      advanceStep: passed ? undefined : false, // don't advance on failed check
    };
  },
};

// ── page.wait_for_mutation ──────────────────────────────────
// Subscribe to DOM mutations via MutationObserver and resolve when a
// structural change matching the selector is observed. Unlike page.wait_for
// (which polls), this listens for changes in real-time — better for SPAs
// where polling can miss fast transitions.

const WAIT_MUTATION_FN = `function(selector, timeoutMs) {
  var deadline = Date.now() + timeoutMs;
  return new Promise(function(resolve) {
    // Check if already present
    if (selector && document.querySelector(selector)) {
      resolve({found:true, method:'already_present', tag:document.querySelector(selector).tagName.toLowerCase()});
      return;
    }
    // Watch for new content
    var observer = new MutationObserver(function(muts) {
      if (selector) {
        if (document.querySelector(selector)) {
          observer.disconnect();
          resolve({found:true, method:'mutation', tag:document.querySelector(selector).tagName.toLowerCase()});
        }
      } else {
        // Any mutation that added visible content
        for (var i=0; i<muts.length; i++) {
          var added = muts[i].addedNodes;
          for (var j=0; j<added.length; j++) {
            if (added[j].nodeType === 1) {
              var el = added[j];
              if (el.offsetParent !== null || el.getBoundingClientRect) {
                var tag = el.tagName ? el.tagName.toLowerCase() : 'text';
                var text = (el.textContent || '').trim().substring(0, 200);
                observer.disconnect();
                resolve({found:true, method:'mutation', tag:tag, text:text});
                return;
              }
            }
          }
        }
      }
    });
    observer.observe(document.body || document.documentElement, {
      childList: true, subtree: true, attributes: false, characterData: false
    });
    // Timeout fallback
    setTimeout(function() {
      observer.disconnect();
      resolve({found:false, method:'timeout'});
    }, timeoutMs);
  });
}`;

export const pageWaitMutationTool: ToolDefDescriptor<{ tabId: number; selector?: string; timeoutMs?: number }> = {
  name: 'page.wait_for_mutation',
  description:
    'Watch the DOM for structural changes (new elements appearing) and resolve when they happen. Unlike page.wait_for which polls every 200ms, this subscribes to real-time DOM mutations — better for SPAs with fast transitions. If a selector is provided, resolves when that element appears. Without a selector, resolves on ANY visible DOM addition. Use after triggering dynamic content (clicking a "load more" button, submitting a search, switching a tab in-page).',
  argsSchema: z.object({
    tabId: z.number().int().describe('Target tab ID'),
    selector: z.string().optional().describe('CSS selector to wait for (e.g. ".new-content"). Without this, waits for any DOM addition.'),
    timeoutMs: z.number().int().min(1000).max(30000).optional().describe('Max wait time in ms (default 10000)'),
  }),
  async dispatch({ tabId, selector, timeoutMs }) {
    const timeout = timeoutMs ?? 10000;
    const result = await withCdp(tabId, async (send) => {
      await send('Runtime.enable');
      const { result: res } = await send<{ result?: { value?: { found?: boolean; method?: string; tag?: string; text?: string } } }>('Runtime.evaluate', {
        expression: `(${WAIT_MUTATION_FN})(${JSON.stringify(selector ?? null)}, ${timeout})`,
        returnByValue: true,
        awaitPromise: true,
      });
      return res?.value;
    });
    if (!result || !result.found) {
      return { ok: false, content: `No DOM mutation detected${selector ? ` for "${selector}"` : ''} within ${timeout}ms.` };
    }
    const tag = result.tag ? `<${result.tag}>` : '';
    const text = result.text ? ` — ${result.text.substring(0, 300)}` : '';
    return { ok: true, content: `Mutation detected${selector ? `: "${selector}" (${tag})` : ` — new ${tag} appeared`}${text}` };
  },
};
