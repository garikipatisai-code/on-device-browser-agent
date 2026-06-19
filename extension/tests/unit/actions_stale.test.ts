import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the index→backend-node resolution so we can exercise the action dispatch
// without mocking the entire ARIA extraction pipeline.
vi.mock('@/agent/tools/browser/aria_tool', () => ({
  resolveBackendId: vi.fn(async () => 42),
  clearExtractionCache: vi.fn(),
}));

import { tabClickTool } from '@/agent/tools/browser/actions';
import type { ToolContext } from '@/agent/tools/registry';

describe('tab.click — stale element-index detection', () => {
  let origDebugger: typeof chrome.debugger;
  let origGet: typeof chrome.tabs.get;
  let connected = true;

  beforeEach(() => {
    origDebugger = chrome.debugger;
    origGet = chrome.tabs.get;
    chrome.tabs.get = ((id: number, cb: (t: unknown) => void) =>
      cb({ id, url: 'https://shop.example/', status: 'complete' })) as unknown as typeof chrome.tabs.get;
    chrome.debugger = {
      attach: (_t: unknown, _v: unknown, cb: () => void) => cb(),
      detach: (_t: unknown, cb: () => void) => cb(),
      sendCommand: (
        _t: unknown,
        method: string,
        params: { functionDeclaration?: string } | undefined,
        cb: (r?: unknown) => void,
      ) => {
        if (method === 'DOM.resolveNode') return cb({ object: { objectId: 'o1' } });
        if (method === 'Runtime.callFunctionOn') {
          const fn = String(params?.functionDeclaration ?? '');
          if (fn.includes('isConnected')) return cb({ result: { value: connected } });
          return cb({ result: {} }); // the actual click
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

  it('returns a clear stale error (not a false "Clicked") when the node is detached', async () => {
    connected = false;
    const res = await tabClickTool.dispatch({ tabId: 5, elementIndex: 3 }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/stale|refresh|changed/i);
  });

  it('clicks normally when the element is still connected', async () => {
    connected = true;
    const res = await tabClickTool.dispatch({ tabId: 5, elementIndex: 3 }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/clicked/i);
  });
});
