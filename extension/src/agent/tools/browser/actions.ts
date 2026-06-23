// Page actions: click, type, select, scroll. Domain-tier gated.

import { z } from 'zod';
import type { ToolDefDescriptor } from '../registry';
import { withCdp } from './lifecycle';
import { assertCanAct } from '@/agent/safety/domain_tiers';
import { resolveBackendId, clearExtractionCache } from './aria_tool';

async function tabUrl(tabId: number): Promise<string> {
  return new Promise((resolve) => chrome.tabs.get(tabId, (t) => resolve(t?.url ?? '')));
}

interface BoxModel {
  content?: number[];
}

async function elementCenter(send: <T>(m: string, p?: Record<string, unknown>) => Promise<T>, backendNodeId: number): Promise<{ x: number; y: number }> {
  const { model } = await send<{ model?: BoxModel }>('DOM.getBoxModel', { backendNodeId });
  const c = model?.content;
  if (!c || c.length < 8) throw new Error('Element has no box model (not visible?)');
  const x = (c[0] + c[2] + c[4] + c[6]) / 4;
  const y = (c[1] + c[3] + c[5] + c[7]) / 4;
  return { x, y };
}

async function scrollIntoView(send: <T>(m: string, p?: Record<string, unknown>) => Promise<T>, backendNodeId: number): Promise<void> {
  await send('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => undefined);
}

async function focusNode(send: <T>(m: string, p?: Record<string, unknown>) => Promise<T>, backendNodeId: number): Promise<void> {
  await send('DOM.focus', { backendNodeId }).catch(() => undefined);
}

async function resolveObjectId(send: <T>(m: string, p?: Record<string, unknown>) => Promise<T>, backendNodeId: number): Promise<string | undefined> {
  try {
    const { object } = await send<{ object?: { objectId?: string } }>('DOM.resolveNode', { backendNodeId });
    return object?.objectId;
  } catch {
    return undefined;
  }
}

// Dynamic-page freshness: a cached element index can resolve to a node that has
// since been detached from the DOM (same-URL mutation). Acting on it silently
// does nothing yet looks like success — so verify the node is still connected and,
// if not, tell the model to re-read instead of reporting a phantom action.
const staleMsg = (i: number) =>
  `Element [${i}] is stale — the page changed since your last read. Call aria.extract to refresh, then act on the new indices.`;

async function isElementConnected(
  send: <T>(m: string, p?: Record<string, unknown>) => Promise<T>,
  objectId: string,
): Promise<boolean> {
  try {
    const { result } = await send<{ result?: { value?: unknown } }>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function() { return !!(this && this.isConnected); }',
      returnByValue: true,
    });
    return result?.value === true;
  } catch {
    return false;
  }
}

// Input.insertText goes to whatever is focused; if the resolved element isn't a text field the
// keystrokes vanish but the action still looks like success. Verify the target is editable so a
// mis-indexed button/link/heading is reported, not silently typed into. Kept permissive (any
// input/textarea/contenteditable + textbox/searchbox/combobox/spinbutton roles) to avoid
// rejecting a legitimate field.
async function isEditable(
  send: <T>(m: string, p?: Record<string, unknown>) => Promise<T>,
  objectId: string,
): Promise<boolean> {
  try {
    const { result } = await send<{ result?: { value?: unknown } }>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration:
        "function(){ try { var r=(this.getAttribute&&this.getAttribute('role'))||''; return !!(this && (this.isContentEditable || this.tagName==='INPUT' || this.tagName==='TEXTAREA' || r==='textbox' || r==='searchbox' || r==='combobox' || r==='spinbutton')); } catch(e){ return false; } }",
      returnByValue: true,
    });
    return result?.value === true;
  } catch {
    return true; // can't tell → don't block a possibly-valid field
  }
}

export const tabClickTool: ToolDefDescriptor<{ tabId: number; elementIndex: number }> = {
  name: 'tab.click',
  description: 'Click an interactive element by its ARIA tree index. Requires click-only tier or higher.',
  argsSchema: z.object({
    tabId: z.number().int(),
    elementIndex: z.number().int().positive(),
  }),
  async dispatch({ tabId, elementIndex }, ctx) {
    const url = await tabUrl(tabId);
    assertCanAct(url, 'click-only', ctx.settings.domainTiers, ctx.settings.bypassDomainTiers);
    const backendNodeId = await resolveBackendId(tabId, elementIndex);
    const stale = await withCdp(tabId, async (send) => {
      await send('DOM.enable');
      await scrollIntoView(send, backendNodeId);
      const objectId = await resolveObjectId(send, backendNodeId);
      if (objectId) {
        if (!(await isElementConnected(send, objectId))) return true; // detached → stale
        // Native element.click() reliably follows links, fires handlers, and
        // submits forms even on a background tab. Synthetic mouse coordinates
        // often did NOT navigate (a product-link click left the URL unchanged).
        await send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: 'function() { this.click(); }',
          returnByValue: true,
        });
      } else {
        const { x, y } = await elementCenter(send, backendNodeId);
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      }
      return false;
    });
    if (stale) return { ok: false, content: staleMsg(elementIndex) };
    clearExtractionCache(tabId);
    return { ok: true, content: `Clicked element [${elementIndex}] on tab ${tabId}` };
  },
};

export const tabTypeTool: ToolDefDescriptor<{ tabId: number; elementIndex: number; text: string; clear?: boolean; submit?: boolean }> = {
  name: 'tab.type',
  description:
    'Type text into a field by ARIA tree index. clear=true wipes existing content first. submit=true submits the form / presses Enter afterward — use this to run a search box (clicking the box does NOT submit). Requires click-only tier.',
  argsSchema: z.object({
    tabId: z.number().int(),
    elementIndex: z.number().int().positive(),
    text: z.string(),
    clear: z.boolean().optional(),
    submit: z.boolean().optional(),
  }),
  async dispatch({ tabId, elementIndex, text, clear, submit }, ctx) {
    const url = await tabUrl(tabId);
    assertCanAct(url, 'click-only', ctx.settings.domainTiers, ctx.settings.bypassDomainTiers);
    const backendNodeId = await resolveBackendId(tabId, elementIndex);
    let notEditable = false;
    const stale = await withCdp(tabId, async (send) => {
      await send('DOM.enable');
      await scrollIntoView(send, backendNodeId);
      await focusNode(send, backendNodeId);
      const objectId = await resolveObjectId(send, backendNodeId);
      if (objectId && !(await isElementConnected(send, objectId))) return true; // detached → stale
      if (objectId && !(await isEditable(send, objectId))) {
        notEditable = true;
        return false;
      }
      if (clear && objectId) {
        await send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: 'function() { try { this.value = ""; this.dispatchEvent(new Event("input", {bubbles:true})); } catch(e) {} }',
          returnByValue: true,
        });
      }
      await send('Input.insertText', { text });
      if (submit && objectId) {
        // Submit via JS — a synthetic Enter/mouse event hangs on a background tab.
        await send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration:
            'function(){ var f=this.form||this.closest("form"); if(f){ if(f.requestSubmit) f.requestSubmit(); else f.submit(); return; } this.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",keyCode:13,which:13,bubbles:true})); this.dispatchEvent(new KeyboardEvent("keyup",{key:"Enter",keyCode:13,which:13,bubbles:true})); }',
          returnByValue: true,
        });
      }
      return false;
    });
    if (stale) return { ok: false, content: staleMsg(elementIndex) };
    if (notEditable) {
      return {
        ok: false,
        content: `Element [${elementIndex}] is not a text field — keystrokes would go nowhere. Use tab.click for buttons/links, or call aria.extract to find the actual input.`,
      };
    }
    clearExtractionCache(tabId);
    return { ok: true, content: `Typed ${text.length} chars into element [${elementIndex}]${submit ? ' and submitted' : ''}` };
  },
};

export const tabSelectTool: ToolDefDescriptor<{ tabId: number; elementIndex: number; value: string }> = {
  name: 'tab.select',
  description: 'Choose an option on a <select> element by value. Requires click-only tier.',
  argsSchema: z.object({
    tabId: z.number().int(),
    elementIndex: z.number().int().positive(),
    value: z.string(),
  }),
  async dispatch({ tabId, elementIndex, value }, ctx) {
    const url = await tabUrl(tabId);
    assertCanAct(url, 'click-only', ctx.settings.domainTiers, ctx.settings.bypassDomainTiers);
    const backendNodeId = await resolveBackendId(tabId, elementIndex);
    const outcome = await withCdp(tabId, async (send) => {
      await send('DOM.enable');
      const objectId = await resolveObjectId(send, backendNodeId);
      // An unresolvable node usually means the page changed under us — give the same
      // actionable refresh guidance the other action tools give, not a bare throw.
      if (!objectId) return { stale: true } as const;
      if (!(await isElementConnected(send, objectId))) return { stale: true } as const;
      // A <select> ignores assignment of a value that isn't one of its options, so read the
      // value back: if it didn't take, the model passed a label/guess instead of the real value.
      const { result } = await send<{ result?: { value?: { ok?: boolean; options?: string[] } } }>('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration:
          "function(v){ try { if(this.tagName!=='SELECT') return {ok:false, options:[]}; var opts=Array.from(this.options).map(function(o){return o.value;}); this.value=v; var ok=this.value===v; if(ok) this.dispatchEvent(new Event('change',{bubbles:true})); return {ok:ok, options:opts}; } catch(e){ return {ok:false, options:[]}; } }",
        arguments: [{ value }],
        returnByValue: true,
      });
      return { stale: false, applied: result?.value?.ok === true, options: result?.value?.options ?? [] } as const;
    });
    if (outcome.stale) return { ok: false, content: staleMsg(elementIndex) };
    clearExtractionCache(tabId);
    if (!outcome.applied) {
      const opts = outcome.options.length ? ` Available values: ${outcome.options.join(', ')}.` : ' (target is not a <select>.)';
      return {
        ok: false,
        content: `Could not select "${value}" in element [${elementIndex}] — not a valid option value.${opts}`,
      };
    }
    return { ok: true, content: `Selected ${value} in element [${elementIndex}]` };
  },
};

export const tabScrollTool: ToolDefDescriptor<{ tabId: number; direction: 'up' | 'down'; pixels?: number }> = {
  name: 'tab.scroll',
  description: 'Scroll the page up or down (default 600px) to read more of it. Allowed on any page you can read — scrolling changes nothing on the page.',
  argsSchema: z.object({
    tabId: z.number().int(),
    direction: z.enum(['up', 'down']),
    pixels: z.number().int().min(50).max(5_000).optional(),
  }),
  async dispatch({ tabId, direction, pixels }) {
    // No tier gate: scrolling is a read-only viewport move (it clicks/types/submits nothing). If
    // the agent is allowed to read the page, it may scroll to reach more of it — blocking this
    // behind click-only stranded the agent on long read-only pages (e.g. Wikipedia lists).
    const dy = (pixels ?? 600) * (direction === 'down' ? 1 : -1);
    const moved = await withCdp(tabId, async (send) => {
      // window.scrollBy via JS — a synthetic mouseWheel event hangs on a background tab. Read
      // scrollY before and after so a clamped scroll (page end / non-scrolling page) is reported
      // honestly instead of as a phantom "Scrolled Npx" the model would trust and loop on.
      const { result } = await send<{ result?: { value?: { before?: number; after?: number } } }>('Runtime.evaluate', {
        expression: `(function(){ var b=window.scrollY||window.pageYOffset||0; window.scrollBy(0, ${dy}); var a=window.scrollY||window.pageYOffset||0; return {before:b, after:a}; })()`,
        returnByValue: true,
      });
      return Math.abs((result?.value?.after ?? 0) - (result?.value?.before ?? 0));
    });
    clearExtractionCache(tabId);
    if (moved === 0) {
      return {
        ok: true,
        content: `Scroll had no effect — already at the ${direction === 'down' ? 'bottom' : 'top'} of the page (or it does not scroll). There is no more content this way.`,
      };
    }
    return { ok: true, content: `Scrolled ${direction} ${moved}px` };
  },
};
