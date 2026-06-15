// chrome.storage.local hot state + IndexedDB warm state.
// - Mutex serializes writes (race-free across SW message handlers)
// - patchHot structurally rejects goal mutations
// - clearHot drains the mutex before erasing

import { openDB, type IDBPDatabase } from 'idb';
import type {
  AgentStatus,
  DomainTier,
  Plan,
  Settings,
  TaskPhase,
  TimelineEvent,
} from '@/shared/messages';
import { DEFAULT_SETTINGS } from '@/shared/messages';

export interface AgentStateHot {
  goal: string; // IMMUTABLE after set
  phase: TaskPhase;
  currentStepId: string | null;
  plan: Plan | null;
  replanCount: number;
  ownedTabs: number[];
  lastTouch: number;
  startedAt: number;
}

const HOT_KEY = 'agent.hot';
const SETTINGS_KEY = 'agent.settings';

// ---------- Mutex (FIFO, single-slot) ----------

type Task<T> = () => Promise<T>;
class Mutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async run<T>(task: Task<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.locked = false;
  }

  async drain(): Promise<void> {
    await this.run(async () => {
      /* serializes after everything in flight */
    });
  }
}

const _hotMutex = new Mutex();

// ---------- chrome.storage shim (test-friendly) ----------

interface StorageShim {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

function chromeStorageShim(): StorageShim {
  const c = (globalThis as { chrome?: typeof chrome }).chrome;
  if (c?.storage?.local) {
    return {
      get: (k) =>
        new Promise((resolve) =>
          c.storage!.local.get(k, (items: Record<string, unknown>) => resolve(items[k])),
        ),
      set: (k, v) =>
        new Promise((resolve) => c.storage!.local.set({ [k]: v }, () => resolve())),
      remove: (k) => new Promise((resolve) => c.storage!.local.remove(k, () => resolve())),
    };
  }
  const mem = new Map<string, unknown>();
  return {
    get: async (k) => mem.get(k),
    set: async (k, v) => {
      mem.set(k, v);
    },
    remove: async (k) => {
      mem.delete(k);
    },
  };
}

let _storage = chromeStorageShim();
export function _setStorage(s: StorageShim) {
  _storage = s;
}

// ---------- Hot state ----------

export async function loadHot(): Promise<AgentStateHot | null> {
  const v = (await _storage.get(HOT_KEY)) as AgentStateHot | undefined;
  return v ?? null;
}

/** Sets fresh hot state for a new task. Only path that may write `goal`. */
export async function _setHot(goal: string): Promise<AgentStateHot> {
  return _hotMutex.run(async () => {
    const next: AgentStateHot = {
      goal,
      phase: 'IDLE',
      currentStepId: null,
      plan: null,
      replanCount: 0,
      ownedTabs: [],
      lastTouch: Date.now(),
      startedAt: Date.now(),
    };
    await _storage.set(HOT_KEY, next);
    return next;
  });
}

type PatchableKeys = Exclude<keyof AgentStateHot, 'goal' | 'startedAt'>;
export async function patchHot(patch: Partial<Pick<AgentStateHot, PatchableKeys>>): Promise<AgentStateHot> {
  return _hotMutex.run(async () => {
    const cur = ((await _storage.get(HOT_KEY)) as AgentStateHot | undefined) ?? null;
    if (!cur) throw new Error('patchHot: no active task');
    if ('goal' in patch) throw new Error('patchHot: goal is immutable');
    if ('startedAt' in patch) throw new Error('patchHot: startedAt is immutable');
    const next: AgentStateHot = { ...cur, ...patch, lastTouch: Date.now() };
    await _storage.set(HOT_KEY, next);
    return next;
  });
}

export async function touchHot(): Promise<void> {
  await _hotMutex.run(async () => {
    const cur = (await _storage.get(HOT_KEY)) as AgentStateHot | undefined;
    if (!cur) return;
    await _storage.set(HOT_KEY, { ...cur, lastTouch: Date.now() });
  });
}

export async function clearHot(): Promise<void> {
  await _hotMutex.drain();
  await _hotMutex.run(async () => {
    await _storage.remove(HOT_KEY);
  });
}

export function toStatus(hot: AgentStateHot | null): AgentStatus {
  if (!hot) {
    return { phase: 'IDLE', goal: null, plan: null, currentStepId: null, replanCount: 0, ownedTabs: [] };
  }
  return {
    phase: hot.phase,
    goal: hot.goal,
    plan: hot.plan,
    currentStepId: hot.currentStepId,
    replanCount: hot.replanCount,
    ownedTabs: hot.ownedTabs,
  };
}

// ---------- Settings ----------

export async function loadSettings(): Promise<Settings> {
  const v = (await _storage.get(SETTINGS_KEY)) as Settings | undefined;
  if (!v) return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...v, domainTiers: { ...DEFAULT_SETTINGS.domainTiers, ...(v.domainTiers ?? {}) } };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next: Settings = {
    ...current,
    ...patch,
    domainTiers: { ...current.domainTiers, ...(patch.domainTiers ?? {}) },
  };
  await _storage.set(SETTINGS_KEY, next);
  return next;
}

export async function setDomainTier(host: string, tier: DomainTier): Promise<Settings> {
  const cur = await loadSettings();
  cur.domainTiers[host] = tier;
  return saveSettings(cur);
}

// ---------- IndexedDB (warm) ----------

const DB_NAME = 'browser-agent';
const DB_VERSION = 1;

export interface FindingRecord {
  id?: number;
  taskId: string;
  stepId?: string;
  ts: number;
  kind: string;
  data: unknown;
}

export interface EventRecord {
  id?: number;
  taskId: string;
  ts: number;
  event: TimelineEvent;
}

export interface MemoryRecord {
  key: string;
  value: unknown;
  updated: number;
}

export interface MetricRecord {
  id?: number;
  ts: number;
  op: string;
  ms: number;
  ok: boolean;
  meta?: Record<string, unknown>;
}

let _dbPromise: Promise<IDBPDatabase> | null = null;

export function db(): Promise<IDBPDatabase> {
  if (_dbPromise) return _dbPromise;
  if (typeof indexedDB === 'undefined') {
    _dbPromise = Promise.reject(new Error('indexedDB not available'));
    return _dbPromise;
  }
  _dbPromise = openDB(DB_NAME, DB_VERSION, {
    upgrade(d) {
      if (!d.objectStoreNames.contains('findings')) {
        const s = d.createObjectStore('findings', { keyPath: 'id', autoIncrement: true });
        s.createIndex('byTask', 'taskId');
      }
      if (!d.objectStoreNames.contains('events')) {
        const s = d.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
        s.createIndex('byTask', 'taskId');
      }
      if (!d.objectStoreNames.contains('memory')) {
        d.createObjectStore('memory', { keyPath: 'key' });
      }
      if (!d.objectStoreNames.contains('metrics')) {
        const s = d.createObjectStore('metrics', { keyPath: 'id', autoIncrement: true });
        s.createIndex('byOp', 'op');
      }
      if (!d.objectStoreNames.contains('scratchpad')) {
        d.createObjectStore('scratchpad', { keyPath: 'taskId' });
      }
    },
  });
  return _dbPromise;
}

export async function appendEvent(taskId: string, event: TimelineEvent): Promise<void> {
  try {
    const d = await db();
    await d.add('events', { taskId, ts: event.ts, event });
  } catch {
    /* tests w/o IDB: ignore */
  }
}

export async function loadEvents(taskId: string): Promise<TimelineEvent[]> {
  try {
    const d = await db();
    const all = (await d.getAllFromIndex('events', 'byTask', taskId)) as EventRecord[];
    return all.map((r) => r.event);
  } catch {
    return [];
  }
}

export async function addFinding(rec: FindingRecord): Promise<void> {
  try {
    const d = await db();
    await d.add('findings', rec);
  } catch {
    /* noop */
  }
}

export async function loadFindings(taskId: string): Promise<FindingRecord[]> {
  try {
    const d = await db();
    return (await d.getAllFromIndex('findings', 'byTask', taskId)) as FindingRecord[];
  } catch {
    return [];
  }
}

export async function memoryGet(key: string): Promise<unknown> {
  try {
    const d = await db();
    const rec = (await d.get('memory', key)) as MemoryRecord | undefined;
    return rec?.value;
  } catch {
    return undefined;
  }
}

export async function memorySet(key: string, value: unknown): Promise<void> {
  try {
    const d = await db();
    await d.put('memory', { key, value, updated: Date.now() });
  } catch {
    /* noop */
  }
}

export async function memoryList(): Promise<string[]> {
  try {
    const d = await db();
    return (await d.getAllKeys('memory')) as string[];
  } catch {
    return [];
  }
}

export async function setScratchpad(taskId: string, content: string): Promise<void> {
  try {
    const d = await db();
    await d.put('scratchpad', { taskId, content, updated: Date.now() });
  } catch {
    /* noop */
  }
}

export async function getScratchpad(taskId: string): Promise<string> {
  try {
    const d = await db();
    const rec = (await d.get('scratchpad', taskId)) as { content?: string } | undefined;
    return rec?.content ?? '';
  } catch {
    return '';
  }
}

export async function recordMetric(rec: MetricRecord): Promise<void> {
  try {
    const d = await db();
    await d.add('metrics', rec);
  } catch {
    /* noop */
  }
}

export async function loadMetrics(): Promise<MetricRecord[]> {
  try {
    const d = await db();
    return (await d.getAll('metrics')) as MetricRecord[];
  } catch {
    return [];
  }
}

// ---------- test-only ----------
export const _testing = {
  _hotMutex,
  _setStorage,
  _resetDb: async () => {
    const p = _dbPromise;
    _dbPromise = null;
    if (p) {
      try {
        (await p).close();
      } catch {
        /* noop */
      }
    }
    // Await actual deletion so the next test starts from a clean DB (no race).
    if (typeof indexedDB !== 'undefined' && indexedDB.deleteDatabase) {
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(DB_NAME);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });
    }
  },
};
