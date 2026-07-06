// Page actions: click, type, select, scroll. Domain-tier gated.

import { z } from 'zod';
import type { ToolDefDescriptor } from '../registry';
import { withCdp, type SendCmd } from './lifecycle';
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
// rejecting a legitimate field. Also reports the element's HTML `type` (date/color/range/etc.)
// so the caller can branch to a different value-assignment strategy for input shapes that
// Input.insertText does not handle correctly.
async function checkEditableAndType(
  send: <T>(m: string, p?: Record<string, unknown>) => Promise<T>,
  objectId: string,
): Promise<{ editable: boolean; type: string }> {
  try {
    const { result } = await send<{ result?: { value?: { editable?: boolean; type?: string } } }>(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration:
          "function(){ try { var r=(this.getAttribute&&this.getAttribute('role'))||''; var editable=!!(this.isContentEditable || this.tagName==='INPUT' || this.tagName==='TEXTAREA' || r==='textbox' || r==='searchbox' || r==='combobox' || r==='spinbutton'); return {editable:editable, type:(this.type||'').toLowerCase()}; } catch(e){ return {editable:true, type:''}; } }",
        returnByValue: true,
      },
    );
    return { editable: result?.value?.editable ?? true, type: result?.value?.type ?? '' };
  } catch {
    return { editable: true, type: '' }; // can't tell → don't block a possibly-valid field
  }
}

// A click that should have toggled a checkbox/radio/switch but silently didn't often means the
// resolved node isn't the thing a real user would click (a visually-hidden real <input> with a
// styled sibling handling the actual toggle is a common pattern). Read the toggle state before
// and after so that case is caught instead of reported as a phantom success. Returns null for
// anything that isn't a checkbox/radio/switch — no verification applies to those. Also reports
// `type` ('checkbox' | 'radio' | 'switch') so the caller can special-case a radio that was
// already checked before the click: clicking an already-checked radio is a legitimate browser
// no-op (state can't go both directions the way a checkbox/switch can), not a failure to verify.
async function readToggleState(
  send: <T>(m: string, p?: Record<string, unknown>) => Promise<T>,
  objectId: string,
): Promise<{ checked: boolean; type: string } | null> {
  try {
    const { result } = await send<{ result?: { value?: { checked?: boolean; type?: string } | null } }>(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration:
          "function(){ try { var t=(this.type||'').toLowerCase(); if(t==='checkbox'||t==='radio') return {checked:this.checked, type:t}; var r=(this.getAttribute&&this.getAttribute('role'))||''; if(r==='switch'||r==='checkbox'||r==='menuitemcheckbox') return {checked:this.getAttribute('aria-checked')==='true', type:r}; return null; } catch(e){ return null; } }",
        returnByValue: true,
      },
    );
    const v = result?.value;
    return v ? { checked: v.checked === true, type: v.type ?? '' } : null;
  } catch {
    return null;
  }
}

// Fallback when a direct click on the resolved node didn't toggle it: click whatever <label>
// is actually wired to it instead.
async function clickAssociatedLabel(
  send: <T>(m: string, p?: Record<string, unknown>) => Promise<T>,
  objectId: string,
): Promise<boolean> {
  try {
    const { result } = await send<{ result?: { value?: boolean } }>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration:
        "function(){ try { var l=null; if(this.id){ var labels=document.querySelectorAll('label'); for(var i=0;i<labels.length;i++){ if(labels[i].getAttribute('for')===this.id){ l=labels[i]; break; } } } if(!l){ l=this.closest('label'); } if(l){ l.click(); return true; } return false; } catch(e){ return false; } }",
      returnByValue: true,
    });
    return result?.value === true;
  } catch {
    return false;
  }
}

// Checked only on the coordinate-fallback path (no resolvable JS object reference exists for
// the target, so an in-page elementFromPoint-vs-object comparison isn't possible). Uses CDP's
// own "what's actually at this point" primitive instead. Fails open — an inconclusive check
// must never block a click that would otherwise have worked.
async function isPointOccluded(
  send: <T>(m: string, p?: Record<string, unknown>) => Promise<T>,
  x: number,
  y: number,
  targetBackendNodeId: number,
): Promise<boolean> {
  try {
    const { backendNodeId } = await send<{ backendNodeId?: number }>('DOM.getNodeForLocation', {
      x: Math.round(x),
      y: Math.round(y),
    });
    if (typeof backendNodeId !== 'number') return false;
    return backendNodeId !== targetBackendNodeId;
  } catch {
    return false;
  }
}

// Plain `this.value = ""` is a raw property assignment; a framework-controlled field (React
// and similar) can silently revert it on the next render since it bypasses the framework's
// tracked-value setter. Going through the property descriptor's own setter — the same one the
// framework itself would call — makes the clear (and later, direct value assignment) actually
// stick.
const SET_NATIVE_VALUE_FN = `function(v){
  try {
    var proto = this.tagName==='TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) { desc.set.call(this, v); } else { this.value = v; }
    this.dispatchEvent(new Event('input', {bubbles:true}));
  } catch(e) { try { this.value = v; } catch(e2) {} }
}`;

// Input.insertText does not reliably work on these input shapes — they need direct value
// assignment via the native setter instead (see SET_NATIVE_VALUE_FN above).
const SPECIAL_VALUE_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range']);

// Input.insertText is appended at the caret, not assigned — if `clear` didn't fully wipe prior
// content (e.g. a framework re-populated the field between the clear and the insert), the typed
// text lands concatenated onto the leftover rather than replacing it. Read the field back so that
// case is caught instead of reported as a phantom "Typed N chars".
async function readValue(
  send: <T>(m: string, p?: Record<string, unknown>) => Promise<T>,
  objectId: string,
): Promise<string> {
  try {
    const { result } = await send<{ result?: { value?: string } }>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: "function(){ try { return String(this.value||''); } catch(e){ return ''; } }",
      returnByValue: true,
    });
    return result?.value ?? '';
  } catch {
    return '';
  }
}

// Submit via JS — a synthetic Enter/mouse event hangs on a background tab.
async function submitViaJs(send: <T>(m: string, p?: Record<string, unknown>) => Promise<T>, objectId: string): Promise<void> {
  await send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration:
      'function(){ var f=this.form||this.closest("form"); if(f){ if(f.requestSubmit) f.requestSubmit(); else f.submit(); return; } this.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",keyCode:13,which:13,bubbles:true})); this.dispatchEvent(new KeyboardEvent("keyup",{key:"Enter",keyCode:13,which:13,bubbles:true})); }',
    returnByValue: true,
  });
}

// Distinguishes a real <select> from an ARIA-combobox-shaped custom dropdown (React-Select,
// MUI, Radix, and similar component libraries render this pattern) before deciding which
// selection strategy to use.
async function readTagAndRole(
  send: <T>(m: string, p?: Record<string, unknown>) => Promise<T>,
  objectId: string,
): Promise<{ tag: string; hasListbox: boolean }> {
  try {
    const { result } = await send<{ result?: { value?: { tag?: string; hasListbox?: boolean } } }>(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration:
          "function(){ try { var r=(this.getAttribute&&this.getAttribute('role'))||''; var lbId=this.getAttribute('aria-controls')||this.getAttribute('aria-owns'); return {tag:this.tagName, hasListbox: r==='combobox' && !!lbId}; } catch(e){ return {tag:'', hasListbox:false}; } }",
        returnByValue: true,
      },
    );
    return { tag: result?.value?.tag ?? '', hasListbox: result?.value?.hasListbox === true };
  } catch {
    return { tag: '', hasListbox: false };
  }
}

// Expands an ARIA combobox, matches `value` against its referenced listbox's option text
// (case-insensitive, trimmed — ARIA listbox options have no native `value` attribute the way
// <option> does), clicks the match, then collapses the popup again. Runs entirely in-page as
// one Promise-returning function so the render delay after expanding doesn't need a second
// round-trip.
//
// Two separate waits, not one: the first (400ms) gives the popup time to render after
// expanding — nothing to read before that finishes. The second (150ms) gives the click's own
// side effect (the framework's onChange/state update closing the popup, updating the
// combobox's displayed text) time to settle before it's read back.
//
// Each setTimeout callback has its own try/catch: an exception thrown by either would
// otherwise escape uncaught in a detached macrotask, leaving the outer Promise forever
// unsettled and the CDP call (awaitPromise: true) hanging for the full 20s command timeout
// instead of failing fast.
export const SELECT_ARIA_COMBOBOX_FN = `function(value){
  var el = this;
  return new Promise(function(resolve){
    try {
      var listboxId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
      el.focus();
      el.click();
      setTimeout(function(){
        try {
          var listbox = document.getElementById(listboxId);
          var opts = listbox ? Array.prototype.slice.call(listbox.querySelectorAll('[role="option"]')) : [];
          var texts = opts.map(function(o){ return (o.textContent||'').trim(); });
          var want = String(value).trim().toLowerCase();
          var matchIndex = -1;
          for (var i=0;i<texts.length;i++){ if (texts[i].toLowerCase()===want){ matchIndex=i; break; } }
          if (matchIndex===-1){
            el.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
            resolve({ok:false, options:texts});
            return;
          }
          var matchedText = texts[matchIndex];
          var matchedOption = opts[matchIndex];
          matchedOption.click();
          setTimeout(function(){
            try {
              // A click alone isn't proof the selection stuck — a disabled option, a debounced
              // onChange slower than this wait, or a listbox that detached the node mid-flight
              // would all otherwise report success on a selection that didn't actually take.
              // Read back the combobox's own state: either it now displays the selected text,
              // or (for a combobox whose visible text doesn't change, e.g. an icon-only trigger)
              // the option itself is marked selected.
              var displayed = (el.textContent||'').trim().toLowerCase();
              var selectedAttr = matchedOption.getAttribute('aria-selected')==='true';
              var stuck = displayed.indexOf(matchedText.toLowerCase())!==-1 || selectedAttr;
              if (el.getAttribute('aria-expanded')==='true'){
                el.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
              }
              resolve({ok:stuck, options:texts});
            } catch(e2){ resolve({ok:false, options:[]}); }
          }, 150);
        } catch(e1){ resolve({ok:false, options:[]}); }
      }, 400);
    } catch(e){ resolve({ok:false, options:[]}); }
  });
}`;

// Shared by tab.type (one field, its own withCdp) and tab.fill_many (N fields, one shared
// withCdp) -- takes an already-open CDP connection so a caller filling several fields can do it
// inside a single attach/detach cycle instead of racing N concurrent ones (chrome.debugger is
// exclusive per tab; withCdp's own finally-detach would otherwise fire while a sibling call was
// still mid-command). This is exactly the per-field body tab.type already had; nothing about
// the read-back-verify/native-setter/date-type logic changed, only where the withCdp lives.
async function fillOneFieldWithSend(
  send: SendCmd,
  backendNodeId: number,
  elementIndex: number,
  text: string,
  opts: { clear?: boolean; submit?: boolean } = {},
): Promise<{ ok: boolean; content: string }> {
  await scrollIntoView(send, backendNodeId);
  await focusNode(send, backendNodeId);
  const objectId = await resolveObjectId(send, backendNodeId);
  if (objectId && !(await isElementConnected(send, objectId))) {
    return { ok: false, content: staleMsg(elementIndex) };
  }
  if (!objectId) {
    await send('Input.insertText', { text });
    return { ok: true, content: `Typed ${text.length} chars into element [${elementIndex}]` };
  }
  const { editable, type } = await checkEditableAndType(send, objectId);
  if (!editable) {
    return {
      ok: false,
      content: `Element [${elementIndex}] is not a text field — keystrokes would go nowhere. Use tab.click for buttons/links, or call aria.extract to find the actual input.`,
    };
  }
  if (SPECIAL_VALUE_TYPES.has(type)) {
    await send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: SET_NATIVE_VALUE_FN,
      arguments: [{ value: text }],
      returnByValue: true,
    });
    if (opts.submit) await submitViaJs(send, objectId);
    return {
      ok: true,
      content: `Typed ${text.length} chars into element [${elementIndex}]${opts.submit ? ' and submitted' : ''}`,
    };
  }
  if (opts.clear) {
    await send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: SET_NATIVE_VALUE_FN,
      arguments: [{ value: '' }],
      returnByValue: true,
    });
  }
  await send('Input.insertText', { text });
  let retriedClear = false;
  const actual = await readValue(send, objectId);
  if (actual !== text && actual.length > text.length && actual.includes(text)) {
    await send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: SET_NATIVE_VALUE_FN,
      arguments: [{ value: '' }],
      returnByValue: true,
    });
    await send('Input.insertText', { text });
    retriedClear = true;
  }
  if (opts.submit) await submitViaJs(send, objectId);
  const retryNote = retriedClear ? ' (retried after leftover content was detected)' : '';
  return {
    ok: true,
    content: `Typed ${text.length} chars into element [${elementIndex}]${opts.submit ? ' and submitted' : ''}${retryNote}`,
  };
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
    let retriedViaLabel = false;
    let occluded = false;
    const stale = await withCdp(tabId, async (send) => {
      await send('DOM.enable');
      await scrollIntoView(send, backendNodeId);
      const objectId = await resolveObjectId(send, backendNodeId);
      if (objectId) {
        if (!(await isElementConnected(send, objectId))) return true; // detached → stale
        const before = await readToggleState(send, objectId);
        // Native element.click() reliably follows links, fires handlers, and
        // submits forms even on a background tab. Synthetic mouse coordinates
        // often did NOT navigate (a product-link click left the URL unchanged).
        await send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: 'function() { this.click(); }',
          returnByValue: true,
        });
        // A radio already checked before the click can never meaningfully fail this check —
        // re-clicking an already-checked radio is a browser no-op (no state change, no `change`
        // event), unlike a checkbox/switch which toggles both directions on every click. Skip
        // the read-and-retry entirely so that no-op isn't misreported as "direct click didn't
        // toggle it."
        if (before !== null && !(before.type === 'radio' && before.checked)) {
          const after = await readToggleState(send, objectId);
          if (after !== null && after.checked === before.checked && (await clickAssociatedLabel(send, objectId))) {
            retriedViaLabel = true;
          }
        }
      } else {
        const { x, y } = await elementCenter(send, backendNodeId);
        if (await isPointOccluded(send, x, y, backendNodeId)) {
          occluded = true;
          return false;
        }
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      }
      return false;
    });
    if (stale) return { ok: false, content: staleMsg(elementIndex) };
    if (occluded) {
      return {
        ok: false,
        content: `Element [${elementIndex}] is covered by another element at that position — call aria.extract to see what's on top, or scroll it into view.`,
      };
    }
    clearExtractionCache(tabId);
    const via = retriedViaLabel ? ' (via associated label — direct click did not toggle it)' : '';
    return { ok: true, content: `Clicked element [${elementIndex}] on tab ${tabId}${via}` };
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
    const result = await withCdp(tabId, async (send) => {
      await send('DOM.enable');
      return fillOneFieldWithSend(send, backendNodeId, elementIndex, text, { clear, submit });
    });
    if (!result.ok) return result;
    clearExtractionCache(tabId);
    return result;
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
      const { tag, hasListbox } = await readTagAndRole(send, objectId);
      if (tag !== 'SELECT' && hasListbox) {
        const { result } = await send<{ result?: { value?: { ok?: boolean; options?: string[] } } }>(
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration: SELECT_ARIA_COMBOBOX_FN,
            arguments: [{ value }],
            returnByValue: true,
            awaitPromise: true,
          },
        );
        return { stale: false, applied: result?.value?.ok === true, options: result?.value?.options ?? [] } as const;
      }
      // A <select> ignores assignment of a value that isn't one of its options, so read the
      // value back: if it didn't take, the model passed a label/guess instead of the real value.
      const { result } = await send<{ result?: { value?: { ok?: boolean; options?: string[] } } }>(
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration:
            "function(v){ try { if(this.tagName!=='SELECT') return {ok:false, options:[]}; var opts=Array.from(this.options).map(function(o){return o.value;}); this.value=v; var ok=this.value===v; if(ok) this.dispatchEvent(new Event('change',{bubbles:true})); return {ok:ok, options:opts}; } catch(e){ return {ok:false, options:[]}; } }",
          arguments: [{ value }],
          returnByValue: true,
        },
      );
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
  description:
    'Scroll the page up or down (default 600px) to read more of it. Allowed on any page you can read. Scrolling itself performs no click/type/submit action, but on an infinite-scroll or lazy-load page it CAN change the DOM — if the content you need still looks incomplete after scrolling, re-read with aria.extract rather than trusting the last read.',
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
