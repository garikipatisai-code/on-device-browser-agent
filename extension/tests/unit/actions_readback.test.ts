import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub index→backend-node resolution so we exercise dispatch without the full ARIA pipeline.
vi.mock('@/agent/tools/browser/aria_tool', () => ({
  resolveBackendId: vi.fn(async () => 42),
  clearExtractionCache: vi.fn(),
}));

import { tabClickTool, tabSelectTool, tabTypeTool, tabScrollTool } from '@/agent/tools/browser/actions';
import type { ToolContext } from '@/agent/tools/registry';

// Configurable CDP responses so each test can model a different page outcome.
interface CdpState {
  connected: boolean;
  objectId: string | undefined;
  selectApplied: boolean;
  selectOptions: string[];
  editable: boolean;
  scrollBefore: number;
  scrollAfter: number;
  toggleSequence: (boolean | null)[];
  labelClickWorked: boolean;
}

describe('action tools — read-back verification (no phantom success)', () => {
  let origDebugger: typeof chrome.debugger;
  let origGet: typeof chrome.tabs.get;
  let s: CdpState;
  let toggleReadIndex = 0;

  beforeEach(() => {
    origDebugger = chrome.debugger;
    origGet = chrome.tabs.get;
    toggleReadIndex = 0;
    s = {
      connected: true,
      objectId: 'o1',
      selectApplied: true,
      selectOptions: ['lg', 'sm'],
      editable: true,
      scrollBefore: 0,
      scrollAfter: 600,
      toggleSequence: [],
      labelClickWorked: false,
    };
    chrome.tabs.get = ((id: number, cb: (t: unknown) => void) =>
      cb({ id, url: 'https://shop.example/', status: 'complete' })) as unknown as typeof chrome.tabs.get;
    chrome.debugger = {
      attach: (_t: unknown, _v: unknown, cb: () => void) => cb(),
      detach: (_t: unknown, cb: () => void) => cb(),
      sendCommand: (
        _t: unknown,
        method: string,
        params: { functionDeclaration?: string; expression?: string } | undefined,
        cb: (r?: unknown) => void,
      ) => {
        if (method === 'DOM.resolveNode') return cb(s.objectId ? { object: { objectId: s.objectId } } : {});
        if (method === 'Runtime.callFunctionOn') {
          const fn = String(params?.functionDeclaration ?? '');
          if (fn.includes('isConnected')) return cb({ result: { value: s.connected } });
          if (fn.includes('aria-checked')) {
            const v = s.toggleSequence[toggleReadIndex] ?? null;
            toggleReadIndex += 1;
            return cb({ result: { value: v } });
          }
          if (fn.includes('labels[i]')) return cb({ result: { value: s.labelClickWorked } });
          if (fn.includes('isContentEditable')) return cb({ result: { value: s.editable } });
          if (fn.includes('options')) return cb({ result: { value: { ok: s.selectApplied, options: s.selectOptions } } });
          return cb({ result: {} });
        }
        if (method === 'Runtime.evaluate') {
          const ex = String(params?.expression ?? '');
          if (ex.includes('scrollBy')) return cb({ result: { value: { before: s.scrollBefore, after: s.scrollAfter, max: 2000 } } });
          return cb({ result: { value: true } });
        }
        cb({});
      },
    } as unknown as typeof chrome.debugger;
  });
  afterEach(() => {
    chrome.debugger = origDebugger;
    chrome.tabs.get = origGet;
  });

  const ctx = () =>
    ({ settings: { domainTiers: { 'shop.example': 'click-only' } }, signal: undefined }) as unknown as ToolContext;

  // AR-M3: passing the visible label ("Large") instead of the option value ("lg") leaves the
  // <select> unchanged; the tool must NOT report a phantom "Selected".
  it('tab.select reports failure when the value is not a real option', async () => {
    s.selectApplied = false;
    const res = await tabSelectTool.dispatch({ tabId: 5, elementIndex: 3, value: 'Large' }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/not a valid option|available values|lg/i);
  });

  it('tab.select succeeds when the value is a real option', async () => {
    s.selectApplied = true;
    const res = await tabSelectTool.dispatch({ tabId: 5, elementIndex: 3, value: 'lg' }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/selected/i);
  });

  // AR-M5: an unresolvable node should give the same actionable stale/refresh guidance the
  // other action tools give — not throw a bare "Could not resolve element".
  it('tab.select returns a stale/refresh message (not a throw) when the node cannot be resolved', async () => {
    s.objectId = undefined;
    const res = await tabSelectTool.dispatch({ tabId: 5, elementIndex: 3, value: 'lg' }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/stale|refresh|changed/i);
  });

  // AR-M4: typing into a button/link/heading (all indexed) sends keystrokes nowhere; the tool
  // must detect a non-editable target rather than reporting "Typed N chars".
  it('tab.type refuses to type into a non-editable element', async () => {
    s.editable = false;
    const res = await tabTypeTool.dispatch({ tabId: 5, elementIndex: 3, text: 'hello' }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/not a text field|cannot type|editable/i);
  });

  it('tab.type types into an editable element', async () => {
    s.editable = true;
    const res = await tabTypeTool.dispatch({ tabId: 5, elementIndex: 3, text: 'hello' }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/typed/i);
  });

  // AR-L8: at the page bottom scrollBy is a no-op; the tool must say so instead of claiming it
  // scrolled, or the model loops trying to reach content that isn't there.
  it('tab.scroll reports no movement when the viewport did not move', async () => {
    s.scrollBefore = 2000;
    s.scrollAfter = 2000;
    const res = await tabScrollTool.dispatch({ tabId: 5, direction: 'down' }, ctx());
    expect(res.content).toMatch(/no effect|already at|bottom|did not/i);
  });

  it('tab.scroll reports the actual distance moved', async () => {
    s.scrollBefore = 0;
    s.scrollAfter = 600;
    const res = await tabScrollTool.dispatch({ tabId: 5, direction: 'down' }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/600/);
  });

  it('tab.scroll works on a read-only domain (scrolling is reading, not acting)', async () => {
    s.scrollBefore = 0;
    s.scrollAfter = 600;
    // read-only tier (no upgrade) used to throw "Cannot click-only" and strand the agent on long
    // pages; scrolling must be allowed wherever the agent can read.
    const readOnly = { settings: { domainTiers: {} }, signal: undefined } as unknown as ToolContext;
    const res = await tabScrollTool.dispatch({ tabId: 5, direction: 'down' }, readOnly);
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/600/);
  });

  it('reports success plainly when a checkbox toggles on the first click', async () => {
    s.toggleSequence = [false, true]; // before: unchecked, after: checked
    const res = await tabClickTool.dispatch({ tabId: 5, elementIndex: 3 }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).not.toMatch(/via associated label/);
  });

  it('retries via the associated label when a checkbox does not toggle on direct click', async () => {
    s.toggleSequence = [false, false]; // before: unchecked, after (post-click): still unchecked
    s.labelClickWorked = true;
    const res = await tabClickTool.dispatch({ tabId: 5, elementIndex: 3 }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/via associated label/);
  });

  it('does not attempt toggle verification on a non-toggle element (link/button)', async () => {
    s.toggleSequence = []; // readToggleState returns null (no entries) — not a checkbox/radio/switch
    const res = await tabClickTool.dispatch({ tabId: 5, elementIndex: 3 }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).not.toMatch(/via associated label/);
  });
});
