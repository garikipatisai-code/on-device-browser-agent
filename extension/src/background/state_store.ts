// chrome.storage.local hot state + IndexedDB warm state.
// - Mutex serializes writes (race-free across SW message handlers)
// - patchHot structurally rejects goal mutations
// - clearHot drains the mutex before erasing

import { openDB, type IDBPDatabase } from 'idb';
import { ulid } from '@/agent/util';
import type {
  AgentStatus,
  DomainTier,
  Plan,
  Session,
  Settings,
  TaskPhase,
  TimelineEvent,
} from '@/shared/messages';
import { DEFAULT_SETTINGS, type FrontierConfig } from '@/shared/messages';
import type { Fact } from '@/agent/facts';
import { redact, redactDeep } from '@/agent/safety/redact';

export interface AgentStateHot {
  goal: string; // IMMUTABLE after set
  phase: TaskPhase;
  currentStepId: string | null;
  plan: Plan | null;
  replanCount: number;
  ownedTabs: number[];
  lastTouch: number;
  startedAt: number;
  // True once the planner's internal recipe-parity retry (roles/planner.ts) has fired once for
  // this task. Bounds that retry to a single occurrence across the whole task, no matter how many
  // times the orchestrator's outer replan() loop calls runPlanner again (each of those calls would
  // otherwise re-trigger the same collapsed-plan retry, compounding up to ~6 planner calls).
  recipeRetryUsed?: boolean;
}

const HOT_KEY = 'agent.hot';
const SETTINGS_KEY = 'agent.settings';
const ACTIVE_SESSION_KEY = 'agent.activeSessionId';

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
// Settings are a separate read-modify-write surface from hot state; without their own mutex,
// two concurrent setDomainTier/saveSettings calls both read the same base and the last write
// silently drops the others (e.g. toggling a tier while saving the model).
const _settingsMutex = new Mutex();

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
      recipeRetryUsed: false,
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

// ---------- Active session pointer ----------
// Persisted separately from AgentStateHot (which is scoped to one in-flight task and cleared on
// completion) — this pointer needs to survive well past any single task's lifetime, across
// however many SW restarts happen between messages in the same chat.

export async function loadActiveSessionId(): Promise<string | null> {
  return ((await _storage.get(ACTIVE_SESSION_KEY)) as string | undefined) ?? null;
}

export async function saveActiveSessionId(id: string | null): Promise<void> {
  if (id === null) await _storage.remove(ACTIVE_SESSION_KEY);
  else await _storage.set(ACTIVE_SESSION_KEY, id);
}

// ---------- Settings ----------

/** One-time migration from v0 (scattered model/frontier/thinking fields) to
 *  v1 (AgentConfig with brain/body RoleGroupConfigs). Writes the migrated
 *  shape back to storage so the old fields are never read again. */
function migrateSettings(raw: Settings): Settings {
  if (raw.schemaVersion !== undefined && raw.agent) return raw; // already migrated

  // v0 default was "no override" which meant roles used their own thinking:true.
  // Map: explicitly off → 'off', explicitly on with effort → mapped level,
  // not set → 'standard' for brain (planner/evaluator), 'fast' for body (executor/compactor).
  const bThink = raw.leadThinking === undefined ? 'standard' as const
    : raw.leadThinking === false ? 'off' as const
    : (raw.leadThinkingEffort === 'low' ? 'fast' as const : raw.leadThinkingEffort === 'medium' ? 'standard' as const : 'full' as const);
  const hThink = raw.helperThinking === undefined ? 'fast' as const
    : raw.helperThinking === false ? 'off' as const
    : (raw.helperThinkingEffort === 'low' ? 'fast' as const : raw.helperThinkingEffort === 'medium' ? 'standard' as const : 'full' as const);

  const bProv = (raw.hybridMode && raw.frontier?.apiKey) ? raw.frontier.provider : 'ollama' as const;
  const hProv = (raw.hybridHelpers && ((raw.helperFrontier?.apiKey) || raw.frontier?.apiKey))
    ? (raw.helperFrontier?.provider ?? raw.frontier?.provider ?? 'ollama' as const)
    : 'ollama' as const;

  const migrated: Settings = {
    ...raw,
    schemaVersion: 1,
    agent: {
      brain: {
        provider: bProv,
        model: bProv === 'ollama' ? (raw.plannerModel ?? 'gemma4:e4b') : raw.frontier!.model,
        apiKey: bProv !== 'ollama' ? raw.frontier?.apiKey : undefined,
        baseUrl: bProv === 'openai-compatible' ? (raw.frontier as Extract<typeof raw.frontier, {provider:'openai-compatible'}>)?.baseUrl : undefined,
        thinkingLevel: bThink,
      },
      body: {
        provider: hProv,
        model: hProv === 'ollama' ? (raw.executorModel ?? 'gemma4:e4b') : ((raw.helperFrontier as FrontierConfig)?.model ?? raw.frontier!.model),
        apiKey: hProv !== 'ollama' ? ((raw.helperFrontier as FrontierConfig)?.apiKey ?? raw.frontier?.apiKey) : undefined,
        baseUrl: hProv === 'openai-compatible' ? ((raw.helperFrontier as Extract<typeof raw.helperFrontier, {provider:'openai-compatible'}>)?.baseUrl ?? (raw.frontier as Extract<typeof raw.frontier, {provider:'openai-compatible'}>)?.baseUrl) : undefined,
        thinkingLevel: hThink,
      },
    },
  };
  // Write back so the old fields are never read again
  _storage.set(SETTINGS_KEY, migrated).catch(() => undefined);
  return migrated;
}

export async function loadSettings(): Promise<Settings> {
  const v = (await _storage.get(SETTINGS_KEY)) as Settings | undefined;
  if (!v) return { ...DEFAULT_SETTINGS };
  const merged = { ...DEFAULT_SETTINGS, ...v, domainTiers: { ...DEFAULT_SETTINGS.domainTiers, ...(v.domainTiers ?? {}) } };
  return migrateSettings(merged);
}

/** Serialized read-modify-write of the settings record. The mutate fn must be pure (it may run
 *  after others in the queue have already written). setDomainTier/saveSettings both route here so
 *  they never re-enter the mutex (a non-reentrant lock would deadlock). */
async function writeSettings(mutate: (cur: Settings) => Settings): Promise<Settings> {
  return _settingsMutex.run(async () => {
    const next = mutate(await loadSettings());
    await _storage.set(SETTINGS_KEY, next);
    return next;
  });
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  return writeSettings((current) => ({
    ...current,
    ...patch,
    domainTiers: { ...current.domainTiers, ...(patch.domainTiers ?? {}) },
  }));
}

export async function setDomainTier(host: string, tier: DomainTier): Promise<Settings> {
  return writeSettings((cur) => ({
    ...cur,
    domainTiers: { ...cur.domainTiers, [host]: tier },
  }));
}

// ---------- IndexedDB (warm) ----------

const DB_NAME = 'browser-agent';
const DB_VERSION = 2;

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
      if (!d.objectStoreNames.contains('sessions')) {
        d.createObjectStore('sessions', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('sessionContext')) {
        d.createObjectStore('sessionContext', { keyPath: 'sessionId' });
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

// ---------- Résumé file (warm; base64 bytes for in-page upload) ----------

export interface ResumeFile {
  name: string;
  mime: string;
  base64: string;
  savedAt: number;
}

const RESUME_KEY = 'resume:file';

export async function saveResumeFile(f: { name: string; mime: string; base64: string }): Promise<void> {
  await memorySet(RESUME_KEY, { ...f, savedAt: Date.now() });
}

export async function loadResumeFile(): Promise<ResumeFile | null> {
  const v = await memoryGet(RESUME_KEY);
  if (v && typeof v === 'object' && typeof (v as ResumeFile).base64 === 'string') {
    return v as ResumeFile;
  }
  return null;
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

// ---------- Sessions (chat-style history + carried-forward context) ----------
// Session itself is defined in @/shared/messages (imported above) — only its
// CRUD lives here, same as every other store.

export interface SessionContext {
  sessionId: string;
  facts: Fact[];
  lastSummary: string;
  updatedAt: number;
}

const SESSION_TITLE_MAX = 80;
const SESSION_SUMMARY_MAX = 500;

export async function createSession(): Promise<Session> {
  const s: Session = {
    id: ulid(),
    title: '',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    turns: [],
  };
  const d = await db();
  await d.put('sessions', s);
  return s;
}

export async function listSessions(): Promise<Session[]> {
  try {
    const d = await db();
    const all = (await d.getAll('sessions')) as Session[];
    return all.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  } catch {
    return [];
  }
}

export async function deleteSession(sessionId: string): Promise<void> {
  const d = await db();
  await d.delete('sessions', sessionId);
  await d.delete('sessionContext', sessionId);
}

/** Appends a turn (taskId + goal) to the session, sets the title from the FIRST turn's goal only
 *  (subsequent turns don't overwrite it), and bumps lastActiveAt. The goal is redacted once and
 *  reused for both the turn and the title — same redaction boundary as updateSessionTurnResult/
 *  saveSessionContext, since Session is IndexedDB-durable across runs, not scoped to one turn. */
export async function appendTurnToSession(sessionId: string, taskId: string, goal?: string): Promise<void> {
  try {
    const d = await db();
    const cur = (await d.get('sessions', sessionId)) as Session | undefined;
    if (!cur) return;
    const redactedGoal = redact(goal ?? '');
    const next: Session = {
      ...cur,
      turns: [...(cur.turns ?? []), { taskId, goal: redactedGoal }],
      title: cur.title || redactedGoal.slice(0, SESSION_TITLE_MAX),
      lastActiveAt: Date.now(),
    };
    await d.put('sessions', next);
  } catch {
    /* best-effort, same pattern as loadSessionContext/saveSessionContext */
  }
}

/** Patches the matching turn's verdict/summary once it reaches a terminal state. Same redaction
 *  boundary + 500-char cap as saveSessionContext's lastSummary — this is the second place a turn's
 *  summary is persisted (the first is inside that turn's own `finish` event), so both copies must
 *  go through `redact` before landing in IndexedDB. */
export async function updateSessionTurnResult(
  sessionId: string,
  taskId: string,
  verdict: string,
  summary: string,
): Promise<void> {
  try {
    const d = await db();
    const cur = (await d.get('sessions', sessionId)) as Session | undefined;
    if (!cur) return;
    const turns = (cur.turns ?? []).map((t) =>
      t.taskId === taskId
        ? { ...t, verdict, summary: redact(summary).slice(0, SESSION_SUMMARY_MAX) }
        : t,
    );
    await d.put('sessions', { ...cur, turns });
  } catch {
    /* best-effort, same pattern as saveSessionContext */
  }
}

export async function loadSessionContext(sessionId: string): Promise<SessionContext> {
  try {
    const d = await db();
    const rec = (await d.get('sessionContext', sessionId)) as SessionContext | undefined;
    return rec ?? { sessionId, facts: [], lastSummary: '', updatedAt: 0 };
  } catch {
    return { sessionId, facts: [], lastSummary: '', updatedAt: 0 };
  }
}

/** Redacts before persisting — sessionContext is IndexedDB-durable across turns (unlike a single
 *  run's in-memory facts), so it must go through the same redaction boundary every other disk
 *  write in this codebase respects (redactEvent for the timeline, redactDeep for findings). */
export async function saveSessionContext(sessionId: string, facts: Fact[], lastSummary: string): Promise<void> {
  try {
    const d = await db();
    await d.put('sessionContext', {
      sessionId,
      facts: redactDeep(facts),
      lastSummary: redact(lastSummary).slice(0, SESSION_SUMMARY_MAX),
      updatedAt: Date.now(),
    });
  } catch {
    /* best-effort, same pattern as setScratchpad/recordMetric */
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
