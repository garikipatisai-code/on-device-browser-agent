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

export const tabClickTool: ToolDefDescriptor<{ tabId: number; elementIndex: number }> = {
  name: 'tab.click',
  description: 'Click an interactive element by its ARIA tree index. Requires click-only tier or higher.',
  argsSchema: z.object({
    tabId: z.number().int(),
    elementIndex: z.number().int().positive(),
  }),
  async dispatch({ tabId, elementIndex }, ctx) {
    const url = await tabUrl(tabId);
    assertCanAct(url, 'click-only', ctx.settings.domainTiers);
    const backendNodeId = await resolveBackendId(tabId, elementIndex);
    await withCdp(tabId, async (send) => {
      await send('DOM.enable');
      await scrollIntoView(send, backendNodeId);
      const objectId = await resolveObjectId(send, backendNodeId);
      if (objectId) {
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
    });
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
    assertCanAct(url, 'click-only', ctx.settings.domainTiers);
    const backendNodeId = await resolveBackendId(tabId, elementIndex);
    await withCdp(tabId, async (send) => {
      await send('DOM.enable');
      await scrollIntoView(send, backendNodeId);
      await focusNode(send, backendNodeId);
      const objectId = await resolveObjectId(send, backendNodeId);
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
    });
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
    assertCanAct(url, 'click-only', ctx.settings.domainTiers);
    const backendNodeId = await resolveBackendId(tabId, elementIndex);
    await withCdp(tabId, async (send) => {
      await send('DOM.enable');
      const objectId = await resolveObjectId(send, backendNodeId);
      if (!objectId) throw new Error('Could not resolve element to a JS object');
      await send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function(v) { try { this.value = v; this.dispatchEvent(new Event('change', {bubbles:true})); } catch(e) {} }`,
        arguments: [{ value }],
        returnByValue: true,
      });
    });
    clearExtractionCache(tabId);
    return { ok: true, content: `Selected ${value} in element [${elementIndex}]` };
  },
};

export const tabScrollTool: ToolDefDescriptor<{ tabId: number; direction: 'up' | 'down'; pixels?: number }> = {
  name: 'tab.scroll',
  description: 'Scroll the page up or down by a given number of pixels (default 600). Requires click-only tier.',
  argsSchema: z.object({
    tabId: z.number().int(),
    direction: z.enum(['up', 'down']),
    pixels: z.number().int().min(50).max(5_000).optional(),
  }),
  async dispatch({ tabId, direction, pixels }, ctx) {
    const url = await tabUrl(tabId);
    assertCanAct(url, 'click-only', ctx.settings.domainTiers);
    const dy = (pixels ?? 600) * (direction === 'down' ? 1 : -1);
    await withCdp(tabId, async (send) => {
      // window.scrollBy via JS — a synthetic mouseWheel event hangs on a background tab.
      await send('Runtime.evaluate', { expression: `window.scrollBy(0, ${dy})`, returnByValue: true });
    });
    clearExtractionCache(tabId);
    return { ok: true, content: `Scrolled ${direction} ${Math.abs(dy)}px` };
  },
};
