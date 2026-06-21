// Vitest setup. Test-friendly stubs for chrome.* APIs used in unit tests.

import { vi } from 'vitest';
// Pure-JS IndexedDB polyfill — happy-dom 20 doesn't ship one.
import 'fake-indexeddb/auto';

const memStorage = new Map<string, unknown>();
const memSession = new Map<string, unknown>();
const memTabs = new Map<number, chrome.tabs.Tab>();
let _tabIdSeq = 100;

(globalThis as { chrome?: unknown }).chrome = {
  runtime: {
    lastError: undefined,
    onConnect: { addListener: vi.fn() },
    connect: vi.fn(),
    onStartup: { addListener: vi.fn() },
    onInstalled: { addListener: vi.fn() },
  },
  storage: {
    local: {
      get: (key: string, cb: (items: Record<string, unknown>) => void) => {
        cb({ [key]: memStorage.get(key) });
      },
      set: (items: Record<string, unknown>, cb: () => void) => {
        for (const [k, v] of Object.entries(items)) memStorage.set(k, v);
        cb();
      },
      remove: (key: string, cb: () => void) => {
        memStorage.delete(key);
        cb();
      },
    },
    // chrome.storage.session — promise-style (modern MV3). In-memory, survives SW recycling.
    session: {
      get: (key: string) => Promise.resolve({ [key]: memSession.get(key) }),
      set: (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) memSession.set(k, v);
        return Promise.resolve();
      },
      remove: (key: string) => {
        memSession.delete(key);
        return Promise.resolve();
      },
    },
  },
  tabs: {
    create: (opts: chrome.tabs.CreateProperties, cb: (t: chrome.tabs.Tab) => void) => {
      const id = ++_tabIdSeq;
      const t = {
        id,
        url: opts.url,
        status: 'complete',
        index: 0,
        pinned: false,
        highlighted: false,
        windowId: 1,
        active: opts.active ?? false,
        incognito: false,
        selected: false,
        discarded: false,
        autoDiscardable: true,
        groupId: -1,
      } as chrome.tabs.Tab;
      memTabs.set(id, t);
      cb(t);
    },
    get: (id: number, cb: (t: chrome.tabs.Tab) => void) => cb(memTabs.get(id)!),
    query: (_q: chrome.tabs.QueryInfo, cb: (t: chrome.tabs.Tab[]) => void) => cb([...memTabs.values()]),
    remove: (id: number | number[], cb: () => void) => {
      const ids = Array.isArray(id) ? id : [id];
      ids.forEach((i) => memTabs.delete(i));
      cb();
    },
    update: (_id: number, _props: chrome.tabs.UpdateProperties, cb: () => void) => cb(),
  },
  debugger: {
    attach: vi.fn(),
    detach: vi.fn(),
    sendCommand: vi.fn(),
  },
  alarms: {
    create: vi.fn(),
    onAlarm: { addListener: vi.fn() },
  },
  action: { onClicked: { addListener: vi.fn() } },
  sidePanel: {
    setPanelBehavior: vi.fn().mockResolvedValue(undefined),
    open: vi.fn().mockResolvedValue(undefined),
  },
};

(globalThis as { __resetTestStorage?: () => void }).__resetTestStorage = () => {
  memStorage.clear();
  memSession.clear();
  memTabs.clear();
  _tabIdSeq = 100;
  // IndexedDB teardown is handled by state_store._resetDb (awaited in resetStorage),
  // which deletes the DB deterministically — don't race a second delete here.
};
