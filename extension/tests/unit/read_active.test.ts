import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tabReadActiveTool } from '@/agent/tools/browser/tab';
import type { ToolContext } from '@/agent/tools/registry';

// A minimal AX tree the CDP mock returns for getFullAXTree → simplifies to readable text.
const AX_NODES = [
  { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2', '3'] },
  { nodeId: '2', parentId: '1', role: { value: 'heading' }, name: { value: 'Quiet Keyboard' }, childIds: [] },
  { nodeId: '3', parentId: '1', role: { value: 'StaticText' }, name: { value: 'Price: £42.00' }, childIds: [] },
];

describe('tab.read_active — read the user’s current page', () => {
  let origDebugger: typeof chrome.debugger;
  let origQuery: typeof chrome.tabs.query;
  let origGet: typeof chrome.tabs.get;
  let activeTab: { id?: number; url?: string };

  beforeEach(() => {
    origDebugger = chrome.debugger;
    origQuery = chrome.tabs.query;
    origGet = chrome.tabs.get;
    activeTab = { id: 7, url: 'https://shop.example/product' };
    chrome.tabs.query = ((_q: unknown, cb: (t: unknown[]) => void) => cb([activeTab])) as unknown as typeof chrome.tabs.query;
    chrome.tabs.get = ((_id: number, cb: (t: unknown) => void) => cb(activeTab)) as unknown as typeof chrome.tabs.get;
    chrome.debugger = {
      attach: (_t: unknown, _v: unknown, cb: () => void) => cb(),
      detach: (_t: unknown, cb: () => void) => cb(),
      sendCommand: (_t: unknown, method: string, _p: unknown, cb: (r?: unknown) => void) => {
        if (method === 'Accessibility.getFullAXTree') return cb({ nodes: AX_NODES });
        cb({});
      },
    } as unknown as typeof chrome.debugger;
  });
  afterEach(() => {
    chrome.debugger = origDebugger;
    chrome.tabs.query = origQuery;
    chrome.tabs.get = origGet;
  });

  const ctx = () => ({ settings: {}, signal: undefined }) as unknown as ToolContext;

  it('reads the active http(s) tab and returns its content + url + tabId', async () => {
    const res = await tabReadActiveTool.dispatch({}, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toContain('Quiet Keyboard');
    expect(res.content).toContain('£42.00');
    expect(res.data?.url).toBe('https://shop.example/product');
    expect(res.data?.tabId).toBe(7);
  });

  it('fails honestly on a restricted page (chrome://) without touching CDP', async () => {
    activeTab = { id: 7, url: 'chrome://settings' };
    let attached = false;
    chrome.debugger = { ...chrome.debugger, attach: () => { attached = true; } } as unknown as typeof chrome.debugger;
    const res = await tabReadActiveTool.dispatch({}, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/can.?t read this page|http/i);
    expect(attached).toBe(false);
  });

  it('fails honestly when there is no active tab', async () => {
    chrome.tabs.query = ((_q: unknown, cb: (t: unknown[]) => void) => cb([])) as unknown as typeof chrome.tabs.query;
    const res = await tabReadActiveTool.dispatch({}, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/no active tab/i);
  });
});
