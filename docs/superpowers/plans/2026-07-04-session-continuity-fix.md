# Session Continuity Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix session continuity so a second message in the same conversation stays in the same chat session across service-worker restarts, and switching to (or opening into) a past session restores its real turn-by-step trace instead of an empty view or a final-result-only view.

**Architecture:** `_activeSessionId` moves from a bare in-memory module variable to a `chrome.storage.local`-backed pointer (mirroring the existing `AgentStateHot` persistence pattern), written through one `setActiveSessionId` helper so no future mutation site can forget to persist, and restored by the existing `crashResume()` SW-startup hook (with a defensive check against a since-deleted session, and an awaited-race fix so the panel's first command can't run ahead of restoration). A new `session.turnEvents`/`turnEvents` command pair exposes the already-existing `loadEvents(taskId)` IndexedDB read to the panel — nothing new to store, just a new read path. `App.tsx`'s reset-on-session-switch effect requests that real trace (for both the cold-open and switch-while-open cases) instead of clearing to empty.

**Tech Stack:** TypeScript, `chrome.storage.local` (via the existing `_storage` shim in `state_store.ts`), IndexedDB via `idb` (existing `loadEvents`), React `useEffect`/`useRef`, Vitest.

**Reference spec:** `docs/superpowers/specs/2026-07-04-session-continuity-fix-design.md`

---

### Task 1: Persist the active session id (`state_store.ts`)

**Files:**
- Modify: `extension/src/background/state_store.ts`
- Test: `extension/tests/unit/state_store.test.ts`

- [ ] **Step 1: Write the failing tests**

In `extension/tests/unit/state_store.test.ts`, add `loadActiveSessionId, saveActiveSessionId` to the existing import block from `@/background/state_store`:

```ts
import {
  _setHot,
  appendEvent,
  appendTurnToSession,
  clearHot,
  createSession,
  deleteSession,
  getScratchpad,
  listSessions,
  loadActiveSessionId,
  loadEvents,
  loadHot,
  loadSessionContext,
  loadSettings,
  memoryGet,
  memoryList,
  memorySet,
  patchHot,
  saveActiveSessionId,
  saveSessionContext,
  saveSettings,
  setDomainTier,
  setScratchpad,
  toStatus,
  touchHot,
  updateSessionTurnResult,
  _testing,
} from '@/background/state_store';
```

Add a new `describe` block immediately before the existing `describe('sessions', ...)` block:

```ts
describe('active session pointer', () => {
  it('round-trips a saved id', async () => {
    expect(await loadActiveSessionId()).toBeNull();
    await saveActiveSessionId('session-123');
    expect(await loadActiveSessionId()).toBe('session-123');
  });

  it('saving null removes the key entirely, not just sets it to null', async () => {
    await saveActiveSessionId('session-123');
    await saveActiveSessionId(null);
    expect(await loadActiveSessionId()).toBeNull();
  });
});

```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npx vitest run tests/unit/state_store.test.ts`
Expected: FAIL — `loadActiveSessionId`/`saveActiveSessionId` are not exported from `@/background/state_store`.

- [ ] **Step 3: Implement `loadActiveSessionId`/`saveActiveSessionId`**

In `extension/src/background/state_store.ts`, find:

```ts
const HOT_KEY = 'agent.hot';
const SETTINGS_KEY = 'agent.settings';
```

Replace with:

```ts
const HOT_KEY = 'agent.hot';
const SETTINGS_KEY = 'agent.settings';
const ACTIVE_SESSION_KEY = 'agent.activeSessionId';
```

Then find the `toStatus` function and the `// ---------- Settings ----------` divider right after it:

```ts
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
```

Replace with:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && npx vitest run tests/unit/state_store.test.ts`
Expected: PASS — all tests in the file green, including the two new ones.

- [ ] **Step 5: Typecheck**

Run: `cd extension && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd extension && git add src/background/state_store.ts tests/unit/state_store.test.ts
git commit -m "feat(state_store): persist the active session id across SW restarts"
```

---

### Task 2: Restore `_activeSessionId` on crash-resume, route every write through one helper

**Files:**
- Modify: `extension/src/background/index.ts`
- Test: `extension/tests/unit/background_run_lifecycle.test.ts`

- [ ] **Step 1: Write the failing tests**

In `extension/tests/unit/background_run_lifecycle.test.ts`, update the top-level import from `@/background/state_store`:

```ts
import { _setHot, listSessions, loadHot, patchHot } from '@/background/state_store';
```

Replace with:

```ts
import {
  _setHot,
  createSession,
  listSessions,
  loadActiveSessionId,
  loadHot,
  patchHot,
  saveActiveSessionId,
} from '@/background/state_store';
```

In the `describe('crash-resume: SW restart finds an in-flight task', ...)` block, add these two tests right after the existing `'is a no-op when there is no in-flight task...'` test and before the `'the lingering ABORTED does not persist forever...'` test:

```ts
  it('restores a previously-saved activeSessionId when the session still exists', async () => {
    const s = await createSession();
    await saveActiveSessionId(s.id);

    await bg.crashResume();

    expect(bg.state().activeSessionId).toBe(s.id);
  });

  it('resets a stale activeSessionId to null when the saved session no longer exists', async () => {
    await saveActiveSessionId('a-session-id-that-was-deleted');

    await bg.crashResume();

    expect(bg.state().activeSessionId).toBeNull();
    expect(await loadActiveSessionId()).toBeNull();
  });

```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npx vitest run tests/unit/background_run_lifecycle.test.ts`
Expected: FAIL — `crashResume` doesn't touch `activeSessionId` yet, so both new tests see `bg.state().activeSessionId` stay `null` for the first test (should be `s.id`) and stay unset in storage for the second (should already be `null`, so that one may pass by accident — the first new test is the one that must fail).

- [ ] **Step 3: Import the new state_store functions**

In `extension/src/background/index.ts`, find:

```ts
import {
  createSession,
  deleteSession,
  listSessions,
  loadHot,
  loadSettings,
  patchHot,
  saveResumeFile,
  saveSettings,
  setDomainTier,
  toStatus,
} from './state_store';
```

Replace with:

```ts
import {
  createSession,
  deleteSession,
  listSessions,
  loadActiveSessionId,
  loadHot,
  loadSettings,
  patchHot,
  saveActiveSessionId,
  saveResumeFile,
  saveSettings,
  setDomainTier,
  toStatus,
} from './state_store';
```

- [ ] **Step 4: Add the `setActiveSessionId` helper**

Find:

```ts
async function pushSessions() {
  broadcast({ type: 'sessions', sessions: await listSessions(), activeSessionId: _activeSessionId });
}

/** Fast path for chitchat (see quick_chat.ts) — no session, no Orchestrator, one lightweight
 *  model call. Falls back to a static reply if the call fails (Ollama down, timeout, etc.) rather
 *  than surfacing an error for what's supposed to be the most forgiving path in the app. */
async function handleQuickChat(goal: string) {
```

Replace with:

```ts
async function pushSessions() {
  broadcast({ type: 'sessions', sessions: await listSessions(), activeSessionId: _activeSessionId });
}

/** Every WRITE to _activeSessionId must go through here — a bare assignment would leave the
 *  pointer unpersisted, and Chrome idle-killing the SW between chat messages (completely normal
 *  mid-conversation) would then silently lose track of which session is active on the next
 *  message. Routing all writes through one helper makes that structurally impossible for any
 *  future mutation site too, not just today's four. */
async function setActiveSessionId(id: string | null): Promise<void> {
  _activeSessionId = id;
  await saveActiveSessionId(id);
}

/** Fast path for chitchat (see quick_chat.ts) — no session, no Orchestrator, one lightweight
 *  model call. Falls back to a static reply if the call fails (Ollama down, timeout, etc.) rather
 *  than surfacing an error for what's supposed to be the most forgiving path in the app. */
async function handleQuickChat(goal: string) {
```

- [ ] **Step 5: Route the four existing mutation sites through the helper**

Find:

```ts
async function handleSessionNew() {
  // Same guard shape as handleSessionSelect: starting a fresh chat mid-run would orphan the
  // live turn's _activeSessionId out from under it.
  if (_orch || _starting) {
    broadcast({ type: 'error', message: 'A task is already running. Stop it first.' });
    return;
  }
  const s = await createSession();
  _activeSessionId = s.id;
  await pushSessions();
}

async function handleSessionSelect(sessionId: string) {
  // Matches handleStart's own guard: _starting closes the async preflight gap
  // (ping/listModels) before _orch is set, so this must check both, not just _orch.
  if (_orch || _starting) {
    broadcast({ type: 'error', message: 'A task is already running. Stop it first.' });
    return;
  }
  _activeSessionId = sessionId;
  await pushSessions();
}

async function handleSessionDelete(sessionId: string) {
  // Deleting a DIFFERENT, inactive session while a turn runs is harmless and stays allowed;
  // only deleting the session the live turn is actually writing into is refused.
  if (sessionId === _activeSessionId && (_orch || _starting)) {
    broadcast({ type: 'error', message: 'A task is already running. Stop it first.' });
    return;
  }
  await deleteSession(sessionId);
  if (_activeSessionId === sessionId) _activeSessionId = null;
  await pushSessions();
}
```

Replace with:

```ts
async function handleSessionNew() {
  // Same guard shape as handleSessionSelect: starting a fresh chat mid-run would orphan the
  // live turn's _activeSessionId out from under it.
  if (_orch || _starting) {
    broadcast({ type: 'error', message: 'A task is already running. Stop it first.' });
    return;
  }
  const s = await createSession();
  await setActiveSessionId(s.id);
  await pushSessions();
}

async function handleSessionSelect(sessionId: string) {
  // Matches handleStart's own guard: _starting closes the async preflight gap
  // (ping/listModels) before _orch is set, so this must check both, not just _orch.
  if (_orch || _starting) {
    broadcast({ type: 'error', message: 'A task is already running. Stop it first.' });
    return;
  }
  await setActiveSessionId(sessionId);
  await pushSessions();
}

async function handleSessionDelete(sessionId: string) {
  // Deleting a DIFFERENT, inactive session while a turn runs is harmless and stays allowed;
  // only deleting the session the live turn is actually writing into is refused.
  if (sessionId === _activeSessionId && (_orch || _starting)) {
    broadcast({ type: 'error', message: 'A task is already running. Stop it first.' });
    return;
  }
  await deleteSession(sessionId);
  if (_activeSessionId === sessionId) await setActiveSessionId(null);
  await pushSessions();
}
```

Now find the fourth site, inside `handleStart`'s auto-create branch:

```ts
  if (autoSession && !_activeSessionId) {
    const s = await createSession();
    _activeSessionId = s.id;
    await pushSessions();
  }
```

Replace with:

```ts
  if (autoSession && !_activeSessionId) {
    const s = await createSession();
    await setActiveSessionId(s.id);
    await pushSessions();
  }
```

- [ ] **Step 6: Extend `crashResume` and fix the startup race**

Find:

```ts
async function crashResume(): Promise<void> {
  try {
    const hot = await loadHot();
    if (hot && hot.phase !== 'IDLE' && hot.phase !== 'DONE' && hot.phase !== 'ABORTED') {
      console.warn('[browser-agent] crash-resume: found in-flight task, marking ABORTED');
      await patchHot({ phase: 'ABORTED' });
    }
  } catch (err) {
    // Never let SW-startup state recovery become an unhandled rejection.
    console.warn('[browser-agent] crash-resume failed:', (err as Error)?.message);
  }
}
void crashResume();
```

Replace with:

```ts
async function crashResume(): Promise<void> {
  try {
    const hot = await loadHot();
    if (hot && hot.phase !== 'IDLE' && hot.phase !== 'DONE' && hot.phase !== 'ABORTED') {
      console.warn('[browser-agent] crash-resume: found in-flight task, marking ABORTED');
      await patchHot({ phase: 'ABORTED' });
    }
    const restored = await loadActiveSessionId();
    // Defensive: don't resurrect a pointer to a session that no longer exists (e.g. IndexedDB
    // was cleared independently of chrome.storage.local — the two aren't transactional).
    if (restored && !(await listSessions()).some((s) => s.id === restored)) {
      await saveActiveSessionId(null);
    } else {
      _activeSessionId = restored;
    }
  } catch (err) {
    // Never let SW-startup state recovery become an unhandled rejection.
    console.warn('[browser-agent] crash-resume failed:', (err as Error)?.message);
  }
}
// Captured (not `void`-discarded) so port.onMessage can await it below — the panel's very first
// command (e.g. session.list) could otherwise race ahead of this restoring _activeSessionId, since
// this is now the first time SW startup does async work that anything the panel asks for depends
// on (before this fix, nothing the panel requested on startup depended on crashResume finishing).
const _crashResumeDone: Promise<void> = crashResume();
```

Now find the port's message listener:

```ts
    port.onMessage.addListener(async (cmd: PanelCommand) => {
      log('command received:', cmd.type);
      try {
        switch (cmd.type) {
```

Replace with:

```ts
    port.onMessage.addListener(async (cmd: PanelCommand) => {
      await _crashResumeDone;
      log('command received:', cmd.type);
      try {
        switch (cmd.type) {
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd extension && npx vitest run tests/unit/background_run_lifecycle.test.ts`
Expected: PASS — all tests in the file green, including the two new crash-resume tests.

- [ ] **Step 8: Run the full test suite + typecheck**

Run: `cd extension && npm run typecheck && npx vitest run`
Expected: no errors, all tests pass (this confirms the four rewritten call sites and the port-listener change didn't regress any existing session/lifecycle test).

- [ ] **Step 9: Commit**

```bash
cd extension && git add src/background/index.ts tests/unit/background_run_lifecycle.test.ts
git commit -m "feat(background): restore activeSessionId on crash-resume, route writes through one helper"
```

---

### Task 3: `session.turnEvents` command — expose a past turn's full trace

**Files:**
- Modify: `extension/src/shared/messages.ts`
- Modify: `extension/src/background/index.ts`
- Test: `extension/tests/unit/background_run_lifecycle.test.ts`

- [ ] **Step 1: Add the new command/update message shapes**

In `extension/src/shared/messages.ts`, find:

```ts
export type PanelCommand =
  | { type: 'agent.start'; goal: string }
  | { type: 'agent.askPage'; question: string }
  | { type: 'agent.steer'; text: string }
  | { type: 'agent.abort' }
  | { type: 'agent.status' }
  | { type: 'settings.get' }
  | { type: 'settings.set'; settings: Partial<Settings> }
  | { type: 'domainTier.set'; host: string; tier: DomainTier }
  | { type: 'profile.extract'; resumeText: string }
  | { type: 'resume.store'; name: string; mime: string; base64: string }
  | { type: 'recipes.clear' }
  | { type: 'recipes.list' }
  | { type: 'recipes.save'; input: UserRecipeDraft }
  | { type: 'recipes.delete'; id: string }
  | { type: 'models.list' }
  | { type: 'preflight' }
  | { type: 'session.new' }
  | { type: 'session.list' }
  | { type: 'session.select'; sessionId: string }
  | { type: 'session.delete'; sessionId: string };
```

Replace with:

```ts
export type PanelCommand =
  | { type: 'agent.start'; goal: string }
  | { type: 'agent.askPage'; question: string }
  | { type: 'agent.steer'; text: string }
  | { type: 'agent.abort' }
  | { type: 'agent.status' }
  | { type: 'settings.get' }
  | { type: 'settings.set'; settings: Partial<Settings> }
  | { type: 'domainTier.set'; host: string; tier: DomainTier }
  | { type: 'profile.extract'; resumeText: string }
  | { type: 'resume.store'; name: string; mime: string; base64: string }
  | { type: 'recipes.clear' }
  | { type: 'recipes.list' }
  | { type: 'recipes.save'; input: UserRecipeDraft }
  | { type: 'recipes.delete'; id: string }
  | { type: 'models.list' }
  | { type: 'preflight' }
  | { type: 'session.new' }
  | { type: 'session.list' }
  | { type: 'session.select'; sessionId: string }
  | { type: 'session.delete'; sessionId: string }
  | { type: 'session.turnEvents'; taskId: string };
```

Then find:

```ts
export type SwUpdate =
  | { type: 'status'; status: AgentStatus }
  | { type: 'timeline'; events: TimelineEvent[] }
  | { type: 'append'; event: TimelineEvent }
  | { type: 'settings'; settings: Settings }
  | { type: 'preflight'; ok: boolean; details: Record<string, unknown> }
  | { type: 'models'; ok: boolean; models: string[]; error?: string }
  | { type: 'profileExtracted'; ok: boolean; profileJson?: string; error?: string }
  | { type: 'resumeStored'; ok: boolean; name?: string; error?: string }
  | { type: 'recipes'; recipes: RecipeView[] }
  | { type: 'metrics'; metrics: MetricsSnapshot }
  | { type: 'error'; message: string }
  | { type: 'sessions'; sessions: Session[]; activeSessionId: string | null };
```

Replace with:

```ts
export type SwUpdate =
  | { type: 'status'; status: AgentStatus }
  | { type: 'timeline'; events: TimelineEvent[] }
  | { type: 'append'; event: TimelineEvent }
  | { type: 'settings'; settings: Settings }
  | { type: 'preflight'; ok: boolean; details: Record<string, unknown> }
  | { type: 'models'; ok: boolean; models: string[]; error?: string }
  | { type: 'profileExtracted'; ok: boolean; profileJson?: string; error?: string }
  | { type: 'resumeStored'; ok: boolean; name?: string; error?: string }
  | { type: 'recipes'; recipes: RecipeView[] }
  | { type: 'metrics'; metrics: MetricsSnapshot }
  | { type: 'error'; message: string }
  | { type: 'sessions'; sessions: Session[]; activeSessionId: string | null }
  | { type: 'turnEvents'; taskId: string; events: TimelineEvent[] };
```

- [ ] **Step 2: Write the failing test**

In `extension/tests/unit/background_run_lifecycle.test.ts`, add `appendEvent` to the import block from `@/background/state_store` (added in Task 2):

```ts
import {
  _setHot,
  appendEvent,
  createSession,
  listSessions,
  loadActiveSessionId,
  loadHot,
  patchHot,
  saveActiveSessionId,
} from '@/background/state_store';
```

In the `describe('session commands', ...)` block, add this test as the LAST test, right after the existing `'a chitchat message never creates a session or touches the orchestrator...'` test, before that describe block's closing `});`:

```ts

  it('handleSessionTurnEvents broadcasts loadEvents(taskId)\'s actual content for an arbitrary taskId, not just the live run\'s', async () => {
    await appendEvent('a-past-task', { kind: 'log', ts: 1, level: 'info', message: 'from a past run' });
    const messages = bg.addTestPanel();

    await bg.handleSessionTurnEvents('a-past-task');

    expect(messages).toContainEqual({
      type: 'turnEvents',
      taskId: 'a-past-task',
      events: [{ kind: 'log', ts: 1, level: 'info', message: 'from a past run' }],
    });
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd extension && npx vitest run tests/unit/background_run_lifecycle.test.ts`
Expected: FAIL — `bg.addTestPanel` and `bg.handleSessionTurnEvents` don't exist yet.

- [ ] **Step 4: Implement the handler, the switch case, and the test helpers**

In `extension/src/background/index.ts`, find:

```ts
import {
  createSession,
  deleteSession,
  listSessions,
  loadActiveSessionId,
  loadHot,
  loadSettings,
  patchHot,
  saveActiveSessionId,
  saveResumeFile,
  saveSettings,
  setDomainTier,
  toStatus,
} from './state_store';
```

Replace with:

```ts
import {
  createSession,
  deleteSession,
  listSessions,
  loadActiveSessionId,
  loadEvents,
  loadHot,
  loadSettings,
  patchHot,
  saveActiveSessionId,
  saveResumeFile,
  saveSettings,
  setDomainTier,
  toStatus,
} from './state_store';
```

Find the `handleSessionDelete` function and add `handleSessionTurnEvents` right after it:

```ts
async function handleSessionDelete(sessionId: string) {
  // Deleting a DIFFERENT, inactive session while a turn runs is harmless and stays allowed;
  // only deleting the session the live turn is actually writing into is refused.
  if (sessionId === _activeSessionId && (_orch || _starting)) {
    broadcast({ type: 'error', message: 'A task is already running. Stop it first.' });
    return;
  }
  await deleteSession(sessionId);
  if (_activeSessionId === sessionId) await setActiveSessionId(null);
  await pushSessions();
}
```

Replace with:

```ts
async function handleSessionDelete(sessionId: string) {
  // Deleting a DIFFERENT, inactive session while a turn runs is harmless and stays allowed;
  // only deleting the session the live turn is actually writing into is refused.
  if (sessionId === _activeSessionId && (_orch || _starting)) {
    broadcast({ type: 'error', message: 'A task is already running. Stop it first.' });
    return;
  }
  await deleteSession(sessionId);
  if (_activeSessionId === sessionId) await setActiveSessionId(null);
  await pushSessions();
}

/** Thin wrapper — loadEvents already exists and already does exactly this read; today it's only
 *  ever called implicitly for the live run's own taskId (via the running Orchestrator's own event
 *  emission). This exposes the same read for ANY taskId, so the panel can restore a past turn's
 *  full trace after a session switch or a fresh panel open. */
async function handleSessionTurnEvents(taskId: string) {
  broadcast({ type: 'turnEvents', taskId, events: await loadEvents(taskId) });
}
```

Now find the `case 'session.delete':` branch in the port's message switch:

```ts
          case 'session.delete':
            await handleSessionDelete(cmd.sessionId);
            break;
          case 'settings.get':
```

Replace with:

```ts
          case 'session.delete':
            await handleSessionDelete(cmd.sessionId);
            break;
          case 'session.turnEvents':
            await handleSessionTurnEvents(cmd.taskId);
            break;
          case 'settings.get':
```

Finally, update the `_testing` export block. Find:

```ts
export const _testing = {
  handleStart,
  handleQuickChat,
  handleAbort,
  handleSessionNew,
  handleSessionSelect,
  handleSessionDelete,
  crashResume,
  setOrchestratorFactory(fn: ((opts: OrchestratorOpts) => Orchestrator) | null) {
    _makeOrchestrator = fn ?? ((opts) => new Orchestrator(opts));
  },
  state: () => ({
    orchSet: _orch !== null,
    runId: _runId,
    starting: _starting,
    keepAlive: _keepAlive !== null,
    events: _events.length,
    activeSessionId: _activeSessionId,
  }),
  reset() {
    _orch = null;
    _abortController = null;
    _starting = false;
    _runId = 0;
    _events = [];
    _activeSessionId = null;
    stopKeepAlive();
  },
};
```

Replace with:

```ts
export const _testing = {
  handleStart,
  handleQuickChat,
  handleAbort,
  handleSessionNew,
  handleSessionSelect,
  handleSessionDelete,
  handleSessionTurnEvents,
  crashResume,
  setOrchestratorFactory(fn: ((opts: OrchestratorOpts) => Orchestrator) | null) {
    _makeOrchestrator = fn ?? ((opts) => new Orchestrator(opts));
  },
  // Registers a fake panel so broadcast() has something to post to, and returns the array it
  // posts into — the only way tests can observe a broadcast's actual payload rather than just its
  // downstream data effects (e.g. listSessions()), which is what every existing broadcast-adjacent
  // test in this file checks instead.
  addTestPanel(): SwUpdate[] {
    const messages: SwUpdate[] = [];
    _panels.add({ postMessage: (m: SwUpdate) => messages.push(m) } as unknown as chrome.runtime.Port);
    return messages;
  },
  state: () => ({
    orchSet: _orch !== null,
    runId: _runId,
    starting: _starting,
    keepAlive: _keepAlive !== null,
    events: _events.length,
    activeSessionId: _activeSessionId,
  }),
  reset() {
    _orch = null;
    _abortController = null;
    _starting = false;
    _runId = 0;
    _events = [];
    _activeSessionId = null;
    _panels.clear();
    stopKeepAlive();
  },
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd extension && npx vitest run tests/unit/background_run_lifecycle.test.ts`
Expected: PASS — all tests in the file green, including the new `handleSessionTurnEvents` test.

- [ ] **Step 6: Run the full test suite + typecheck**

Run: `cd extension && npm run typecheck && npx vitest run`
Expected: no errors, all tests pass.

- [ ] **Step 7: Commit**

```bash
cd extension && git add src/shared/messages.ts src/background/index.ts tests/unit/background_run_lifecycle.test.ts
git commit -m "feat(background): add session.turnEvents command to fetch a past turn's full trace"
```

---

### Task 4: `App.tsx` — restore the real trace on session switch and cold-open

**Files:**
- Modify: `extension/src/sidepanel/App.tsx`

- [ ] **Step 1: Handle the new `turnEvents` update**

In `extension/src/sidepanel/App.tsx`, find:

```ts
        case 'sessions':
          setSessions(msg.sessions);
          setActiveSessionId(msg.activeSessionId);
          break;
```

Replace with:

```ts
        case 'sessions':
          setSessions(msg.sessions);
          setActiveSessionId(msg.activeSessionId);
          break;
        case 'turnEvents':
          setEvents(msg.events);
          break;
```

- [ ] **Step 2: Restructure the reset-on-session-switch effect to restore the real trace**

Find:

```ts
  // Session switches only ever happen while nothing is running (background guards session.select/
  // session.new/session.delete-of-active against a live task), so it's safe to hard-reset the
  // single-turn display the moment activeSessionId changes — this is what makes it structurally
  // impossible to show turn data from the wrong session.
  const prevSessionId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (prevSessionId.current === undefined) {
      prevSessionId.current = activeSessionId; // first update on mount — nothing to reset yet
      return;
    }
    if (prevSessionId.current !== activeSessionId) {
      prevSessionId.current = activeSessionId;
      setEvents([]);
      setNotice(null);
      setRunStartedAt(null);
    }
  }, [activeSessionId]);
```

Replace with:

```ts
  // Session switches only ever happen while nothing is running (background guards session.select/
  // session.new/session.delete-of-active against a live task), so it's safe to hard-reset the
  // single-turn display the moment activeSessionId changes — this is what makes it structurally
  // impossible to show turn data from the wrong session. Both branches below request the real
  // trace instead of clearing to empty, covering the cold-open case (mount) and the switch-while-
  // open case identically. `sessions` is guaranteed current by the time either branch runs here:
  // both `sessions` and `activeSessionId` arrive together in one `case 'sessions':` broadcast, and
  // React batches same-event state updates, so this effect never sees a stale/empty `sessions` for
  // a just-arrived `activeSessionId`.
  const prevSessionId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const lastTaskId = sessions.find((s) => s.id === activeSessionId)?.turns.at(-1)?.taskId;
    if (prevSessionId.current === undefined) {
      prevSessionId.current = activeSessionId; // first update on mount
      if (lastTaskId) send({ type: 'session.turnEvents', taskId: lastTaskId });
      return;
    }
    if (prevSessionId.current !== activeSessionId) {
      prevSessionId.current = activeSessionId;
      setNotice(null);
      setRunStartedAt(null);
      if (lastTaskId) {
        send({ type: 'session.turnEvents', taskId: lastTaskId });
      } else {
        setEvents([]); // a session with no turns yet — nothing to restore
      }
    }
  }, [activeSessionId]);
```

- [ ] **Step 3: Typecheck**

Run: `cd extension && npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Run the full test suite**

Run: `cd extension && npx vitest run`
Expected: PASS — all tests green (`App.tsx` has no dedicated test file per this codebase's existing convention, same as every prior layout/wiring change; this step confirms nothing else regressed).

- [ ] **Step 5: Manual verification in the browser**

Run: `cd extension && npm run build`

Load `extension/dist` as an unpacked extension in Chrome (chrome://extensions → Developer mode → Load unpacked), open the side panel, and verify:

1. **Bug 1 (session continuity across SW restart):** Run a goal to completion. Open `chrome://serviceworker-internals` (or just wait ~35 seconds without interacting with the panel) to let the SW idle-kill, then send a second goal in the same panel. Confirm the second turn's result appears as a NEW turn in the SAME session (the switcher still shows one session, now with two turns in its history), not as a second session in the dropdown.
2. **Bug 2 (switch-while-open restores the real trace):** With at least two sessions each having a completed turn, use the switcher to go from session A to session B. Confirm session B's most recent turn shows its full step-by-step Activity log (Timeline), not just the compact result card with no trace.
3. **Bug 2, cold-open case:** Close the side panel entirely (or reload the extension), then reopen the panel. Confirm the panel opens directly into the previously-active session with its last turn's full trace already populated, not an empty state requiring a manual reselect.
4. Confirm nothing regressed from the earlier agent-tab-polish work: the composer still sits at the bottom, auto-scroll still works, "New chat" still clears to an empty state.

- [ ] **Step 6: Commit**

```bash
cd extension && git add src/sidepanel/App.tsx
git commit -m "fix(sidepanel): restore full turn trace on session switch and cold-open instead of clearing"
```

---

### Task 5: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `cd extension && npx vitest run`
Expected: all tests pass, 0 failures.

- [ ] **Step 2: Typecheck**

Run: `cd extension && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Build**

Run: `cd extension && npm run build`
Expected: succeeds, `extension/dist` produced.

- [ ] **Step 4: Grep for any stray bare `_activeSessionId` writes**

Run: `cd extension && grep -n "_activeSessionId = " src/background/index.ts`
Expected: exactly two matches — the initial declaration (`let _activeSessionId: string | null = null;`) and the `_testing.reset()` test-only reset (`_activeSessionId = null;`). Every other write must read `await setActiveSessionId(...)`. If any other bare assignment remains, replace it with `await setActiveSessionId(...)` before considering this plan done.

- [ ] **Step 5: Commit (if Step 4 required any fixes)**

Only if Step 4 found and required fixing something not already covered:

```bash
cd extension && git add -A
git commit -m "fix: route remaining _activeSessionId writes through setActiveSessionId"
```
