# Chat-sessions Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the GPT-style chat UI (session switcher, scrolling transcript, auto-continuation) on top of the already-merged chat-sessions backend.

**Architecture:** `Session.turnIds: string[]` becomes `Session.turns: SessionTurn[]` so every turn's goal/verdict/summary is structurally recoverable (Task 1). The background auto-creates a session on `agent.start` and re-broadcasts `sessions` when a turn finishes (Task 2). The side panel adds `sessions`/`activeSessionId` state and two new components — `SessionSwitcher` (pick/create/delete a chat) and `Transcript` (read-only history of past turns) — while the existing `RunState`/`ResultCard`/`Timeline` keep rendering the active/most-recent turn unchanged (Tasks 3-5).

**Tech Stack:** TypeScript, React (no external state library — `useState` in `App.tsx`), Vitest (`renderToStaticMarkup` / `react-dom/client` + `act` for component tests), IndexedDB via `idb`.

**Reference spec:** `docs/superpowers/specs/2026-07-04-chat-sessions-frontend-design.md`

---

### Task 1: `Session.turns` replaces `turnIds`

**Files:**
- Modify: `extension/src/shared/messages.ts`
- Modify: `extension/src/background/state_store.ts`
- Modify: `extension/src/agent/orchestrator.ts`
- Test: `extension/tests/unit/state_store.test.ts`
- Test: `extension/tests/integration/orchestrator.test.ts`

- [ ] **Step 1: Add `SessionTurn` and change `Session.turns` in `shared/messages.ts`**

In `extension/src/shared/messages.ts`, find:

```ts
/** A chat-style session: an ordered list of turns (each turn is one Orchestrator run,
 *  its own taskId) sharing carried-forward context (facts + last summary). */
export interface Session {
  id: string;
  title: string;
  createdAt: number;
  lastActiveAt: number;
  turnIds: string[];
}
```

Replace with:

```ts
/** One turn's identity + outcome inside a session's transcript. `verdict`/`summary` are
 *  undefined until the turn reaches a terminal state (set by updateSessionTurnResult). */
export interface SessionTurn {
  taskId: string;
  goal: string;
  verdict?: string;
  summary?: string;
}

/** A chat-style session: an ordered list of turns (each turn is one Orchestrator run,
 *  its own taskId) sharing carried-forward context (facts + last summary). */
export interface Session {
  id: string;
  title: string;
  createdAt: number;
  lastActiveAt: number;
  turns: SessionTurn[];
}
```

- [ ] **Step 2: Write the failing tests for `state_store.ts`**

In `extension/tests/unit/state_store.test.ts`, the `describe('sessions', ...)` block currently asserts on `turnIds`. Replace the whole block:

```ts
describe('sessions', () => {
  it('creates, lists, and deletes a session', async () => {
    const s1 = await createSession();
    const s2 = await createSession();
    const listed = await listSessions();
    expect(listed.map((s) => s.id).sort()).toEqual([s1.id, s2.id].sort());
    expect(s1.title).toBe('');
    expect(s1.turns).toEqual([]);

    await deleteSession(s1.id);
    const afterDelete = await listSessions();
    expect(afterDelete.map((s) => s.id)).toEqual([s2.id]);
  });

  it('lists sessions sorted by lastActiveAt descending', async () => {
    const older = await createSession();
    await appendTurnToSession(older.id, 'task-a');
    const newer = await createSession();
    await appendTurnToSession(newer.id, 'task-b');
    // touch `older` again so it becomes the most recently active
    await appendTurnToSession(older.id, 'task-c');
    const listed = await listSessions();
    expect(listed[0].id).toBe(older.id);
    expect(listed[1].id).toBe(newer.id);
  });

  it('appendTurnToSession appends a {taskId, goal} turn and sets the title from the first turn only', async () => {
    const s = await createSession();
    await appendTurnToSession(s.id, 'task-1', 'find the population of Austin');
    await appendTurnToSession(s.id, 'task-2', 'now do Seattle too');
    const listed = await listSessions();
    const found = listed.find((x) => x.id === s.id)!;
    expect(found.turns).toEqual([
      { taskId: 'task-1', goal: 'find the population of Austin' },
      { taskId: 'task-2', goal: 'now do Seattle too' },
    ]);
    expect(found.title).toBe('find the population of Austin');
  });

  it('truncates a long goal to build the title', async () => {
    const s = await createSession();
    const longGoal = 'x'.repeat(200);
    await appendTurnToSession(s.id, 'task-1', longGoal);
    const listed = await listSessions();
    expect(listed[0].title.length).toBeLessThanOrEqual(80);
  });

  it('updateSessionTurnResult patches the matching turn by taskId', async () => {
    const s = await createSession();
    await appendTurnToSession(s.id, 'task-1', 'goal one');
    await appendTurnToSession(s.id, 'task-2', 'goal two');
    await updateSessionTurnResult(s.id, 'task-1', 'success', 'first answer');
    const listed = await listSessions();
    const found = listed.find((x) => x.id === s.id)!;
    expect(found.turns).toEqual([
      { taskId: 'task-1', goal: 'goal one', verdict: 'success', summary: 'first answer' },
      { taskId: 'task-2', goal: 'goal two' },
    ]);
  });

  it('updateSessionTurnResult caps the summary at 500 chars and redacts PII', async () => {
    const s = await createSession();
    await appendTurnToSession(s.id, 'task-1', 'goal one');
    const long = 'y'.repeat(1000);
    await updateSessionTurnResult(s.id, 'task-1', 'success', long);
    const listed = await listSessions();
    expect(listed[0].turns[0].summary!.length).toBe(500);

    await updateSessionTurnResult(s.id, 'task-1', 'success', 'reach jane.doe@example.com for details');
    const relisted = await listSessions();
    expect(relisted[0].turns[0].summary).toContain('[REDACTED: EMAIL]');
    expect(relisted[0].turns[0].summary).not.toContain('jane.doe@example.com');
  });

  it('updateSessionTurnResult is a no-op when the session or turn does not exist', async () => {
    await expect(updateSessionTurnResult('missing-session', 'task-1', 'success', 'x')).resolves.toBeUndefined();
    const s = await createSession();
    await expect(updateSessionTurnResult(s.id, 'missing-task', 'success', 'x')).resolves.toBeUndefined();
    expect((await listSessions())[0].turns).toEqual([]);
  });
});
```

Add `updateSessionTurnResult` to the import list at the top of the file (alongside the existing `appendTurnToSession`, `createSession`, etc.):

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
  loadEvents,
  loadHot,
  loadSessionContext,
  loadSettings,
  memoryGet,
  memoryList,
  memorySet,
  patchHot,
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

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd extension && npx vitest run tests/unit/state_store.test.ts`
Expected: FAIL — `s1.turns` is `undefined` (the store still writes `turnIds`), and `updateSessionTurnResult` is not exported.

- [ ] **Step 4: Update `state_store.ts`**

In `extension/src/background/state_store.ts`, the `createSession` function currently sets `turnIds: []`. Update:

```ts
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
```

Replace `appendTurnToSession`:

```ts
/** Appends a turn (taskId + goal) to the session, sets the title from the FIRST turn's goal only
 *  (subsequent turns don't overwrite it), and bumps lastActiveAt. */
export async function appendTurnToSession(sessionId: string, taskId: string, goal?: string): Promise<void> {
  try {
    const d = await db();
    const cur = (await d.get('sessions', sessionId)) as Session | undefined;
    if (!cur) return;
    const next: Session = {
      ...cur,
      turns: [...(cur.turns ?? []), { taskId, goal: goal ?? '' }],
      title: cur.title || (goal ?? '').slice(0, SESSION_TITLE_MAX),
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
        ? { ...t, verdict, summary: redact(summary.slice(0, SESSION_SUMMARY_MAX)) }
        : t,
    );
    await d.put('sessions', { ...cur, turns });
  } catch {
    /* best-effort, same pattern as saveSessionContext */
  }
}
```

Note: `redact` and `SESSION_SUMMARY_MAX` are already imported/defined earlier in this file (`import { redact, redactDeep } from '@/agent/safety/redact';` and `const SESSION_SUMMARY_MAX = 500;`) — no new imports needed.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd extension && npx vitest run tests/unit/state_store.test.ts`
Expected: PASS (all `sessions` and `sessionContext` tests green).

- [ ] **Step 6: Update the orchestrator integration test's `turnIds` assertion**

In `extension/tests/integration/orchestrator.test.ts`, find (around line 1966-1968):

```ts
    const finalSessions = await listSessions();
    const finalSession = finalSessions.find((s) => s.id === session.id)!;
    expect(finalSession.turnIds.length).toBe(2);
  });
```

Replace with:

```ts
    const finalSessions = await listSessions();
    const finalSession = finalSessions.find((s) => s.id === session.id)!;
    expect(finalSession.turns.length).toBe(2);
    expect(finalSession.turns[0].goal).toBe('find city alpha population');
    expect(finalSession.turns[0].verdict).toBe('success');
    expect(finalSession.turns[1].goal).toBe('what was the population again?');
    expect(finalSession.turns[1].verdict).toBe('success');
  });
```

- [ ] **Step 7: Wire `updateSessionTurnResult` into `orchestrator.ts`'s `finishOk`/`abortNow`**

In `extension/src/agent/orchestrator.ts`, add `updateSessionTurnResult` to the existing `@/background/state_store` import block:

```ts
import {
  type AgentStateHot,
  _setHot,
  addFinding,
  appendEvent,
  appendTurnToSession,
  clearHot,
  getScratchpad,
  loadHot,
  loadSessionContext,
  patchHot,
  saveSessionContext,
  setScratchpad,
  touchHot,
  updateSessionTurnResult,
} from '@/background/state_store';
```

In `finishOk` (around line 831-838), find:

```ts
  private async finishOk(
    hot: AgentStateHot,
    verdict: string,
    summary: string,
  ): Promise<RunResult> {
    await this.cleanupTabs(hot);
    await patchHot({ phase: 'DONE' });
    if (this.sessionId) await saveSessionContext(this.sessionId, this.facts, `${verdict}: ${summary}`);
```

Replace with:

```ts
  private async finishOk(
    hot: AgentStateHot,
    verdict: string,
    summary: string,
  ): Promise<RunResult> {
    await this.cleanupTabs(hot);
    await patchHot({ phase: 'DONE' });
    if (this.sessionId) {
      await saveSessionContext(this.sessionId, this.facts, `${verdict}: ${summary}`);
      await updateSessionTurnResult(this.sessionId, this.taskId, verdict, summary);
    }
```

In `abortNow` (around line 864-867), find:

```ts
  private async abortNow(hot: AgentStateHot, reason: string): Promise<RunResult> {
    await this.cleanupTabs(hot);
    await patchHot({ phase: 'ABORTED' });
    if (this.sessionId) await saveSessionContext(this.sessionId, this.facts, `aborted: ${reason}`);
```

Replace with:

```ts
  private async abortNow(hot: AgentStateHot, reason: string): Promise<RunResult> {
    await this.cleanupTabs(hot);
    await patchHot({ phase: 'ABORTED' });
    if (this.sessionId) {
      await saveSessionContext(this.sessionId, this.facts, `aborted: ${reason}`);
      await updateSessionTurnResult(this.sessionId, this.taskId, 'aborted', reason);
    }
```

- [ ] **Step 8: Run the full test suite to verify no regressions**

Run: `cd extension && npx vitest run tests/unit/state_store.test.ts tests/integration/orchestrator.test.ts`
Expected: PASS — all tests in both files green, including the new/updated ones from Steps 2 and 6.

- [ ] **Step 9: Typecheck**

Run: `cd extension && npm run typecheck`
Expected: no errors (confirms no other file still references `Session.turnIds`).

- [ ] **Step 10: Commit**

```bash
cd extension && git add src/shared/messages.ts src/background/state_store.ts src/agent/orchestrator.ts tests/unit/state_store.test.ts tests/integration/orchestrator.test.ts
git commit -m "feat(sessions): replace Session.turnIds with structured Session.turns"
```

---

### Task 2: Background wiring — auto-create session, guard mutations, broadcast on finish

**Files:**
- Modify: `extension/src/background/index.ts`
- Test: `extension/tests/unit/background_run_lifecycle.test.ts`

- [ ] **Step 1: Write the failing tests**

In `extension/tests/unit/background_run_lifecycle.test.ts`, the `describe('session commands', ...)` block (starts around line 162) currently has 4 tests. Add these after the existing `handleSessionDelete removes it and clears activeSessionId if it was active` test, inside the same `describe` block, right before its closing `});`:

```ts
  it('agent.start auto-creates a session when none is active', async () => {
    const origFetch = globalThis.fetch;
    const models = [
      DEFAULT_SETTINGS.executorModel,
      DEFAULT_SETTINGS.plannerModel,
      DEFAULT_SETTINGS.evaluatorModel,
      DEFAULT_SETTINGS.compactorModel,
    ].map((name) => ({ name }));
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ models }) }) as Response) as typeof globalThis.fetch;
    let liveOrch: FakeOrch | null = null;
    bg.setOrchestratorFactory((opts) => {
      liveOrch = fakeOrch();
      liveOrch.emit = opts.emit;
      return liveOrch as unknown as Orchestrator;
    });

    expect(bg.state().activeSessionId).toBeNull();
    void bg.handleStart('a goal with no session active');
    await flush();
    expect(bg.state().activeSessionId).not.toBeNull();
    const sessions = await listSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe(bg.state().activeSessionId);

    liveOrch!.finishRun();
    await flush();
    globalThis.fetch = origFetch;
    bg.setOrchestratorFactory(null);
  });

  it('agent.start reuses the already-active session instead of creating a new one', async () => {
    await bg.handleSessionNew();
    const existing = bg.state().activeSessionId;

    const origFetch = globalThis.fetch;
    const models = [
      DEFAULT_SETTINGS.executorModel,
      DEFAULT_SETTINGS.plannerModel,
      DEFAULT_SETTINGS.evaluatorModel,
      DEFAULT_SETTINGS.compactorModel,
    ].map((name) => ({ name }));
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ models }) }) as Response) as typeof globalThis.fetch;
    let liveOrch: FakeOrch | null = null;
    bg.setOrchestratorFactory((opts) => {
      liveOrch = fakeOrch();
      liveOrch.emit = opts.emit;
      return liveOrch as unknown as Orchestrator;
    });

    void bg.handleStart('a follow-up goal');
    await flush();
    expect(bg.state().activeSessionId).toBe(existing);
    const sessions = await listSessions();
    expect(sessions.length).toBe(1);

    liveOrch!.finishRun();
    await flush();
    globalThis.fetch = origFetch;
    bg.setOrchestratorFactory(null);
  });

  it('handleSessionNew refuses to create+switch while a task is running', async () => {
    await bg.handleSessionNew();
    const first = bg.state().activeSessionId;

    const origFetch = globalThis.fetch;
    const models = [
      DEFAULT_SETTINGS.executorModel,
      DEFAULT_SETTINGS.plannerModel,
      DEFAULT_SETTINGS.evaluatorModel,
      DEFAULT_SETTINGS.compactorModel,
    ].map((name) => ({ name }));
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ models }) }) as Response) as typeof globalThis.fetch;
    let liveOrch: FakeOrch | null = null;
    bg.setOrchestratorFactory((opts) => {
      liveOrch = fakeOrch();
      liveOrch.emit = opts.emit;
      return liveOrch as unknown as Orchestrator;
    });

    void bg.handleStart('a goal');
    await flush();
    expect(bg.state().orchSet).toBe(true);

    await bg.handleSessionNew();
    expect(bg.state().activeSessionId).toBe(first); // unchanged — refused while orchSet
    expect((await listSessions()).length).toBe(1); // no second session was created

    liveOrch!.finishRun();
    await flush();
    globalThis.fetch = origFetch;
    bg.setOrchestratorFactory(null);
  });

  it('handleSessionDelete refuses to delete the ACTIVE session while a task is running, but allows deleting an inactive one', async () => {
    await bg.handleSessionNew();
    const active = bg.state().activeSessionId!;
    await bg.handleSessionNew();
    const other = bg.state().activeSessionId!;
    await bg.handleSessionSelect(active);

    const origFetch = globalThis.fetch;
    const models = [
      DEFAULT_SETTINGS.executorModel,
      DEFAULT_SETTINGS.plannerModel,
      DEFAULT_SETTINGS.evaluatorModel,
      DEFAULT_SETTINGS.compactorModel,
    ].map((name) => ({ name }));
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ models }) }) as Response) as typeof globalThis.fetch;
    let liveOrch: FakeOrch | null = null;
    bg.setOrchestratorFactory((opts) => {
      liveOrch = fakeOrch();
      liveOrch.emit = opts.emit;
      return liveOrch as unknown as Orchestrator;
    });

    void bg.handleStart('a goal');
    await flush();
    expect(bg.state().orchSet).toBe(true);

    // Deleting the currently-active session while running is refused.
    await bg.handleSessionDelete(active);
    expect(bg.state().activeSessionId).toBe(active);
    expect((await listSessions()).map((s) => s.id)).toContain(active);

    // Deleting a DIFFERENT (inactive) session while running is still allowed.
    await bg.handleSessionDelete(other);
    expect((await listSessions()).map((s) => s.id)).not.toContain(other);

    liveOrch!.finishRun();
    await flush();
    globalThis.fetch = origFetch;
    bg.setOrchestratorFactory(null);
  });

  it('a finished turn triggers a sessions broadcast whose matching turn carries the verdict/summary', async () => {
    await bg.handleSessionNew();
    const sessionId = bg.state().activeSessionId!;

    const origFetch = globalThis.fetch;
    const models = [
      DEFAULT_SETTINGS.executorModel,
      DEFAULT_SETTINGS.plannerModel,
      DEFAULT_SETTINGS.evaluatorModel,
      DEFAULT_SETTINGS.compactorModel,
    ].map((name) => ({ name }));
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ models }) }) as Response) as typeof globalThis.fetch;
    bg.setOrchestratorFactory((opts) => {
      const o = fakeOrch();
      o.emit = opts.emit;
      // The real Orchestrator.start()/finishOk() are what call the real appendTurnToSession/
      // updateSessionTurnResult — exercise those instead of the fake's static stubs, mirroring
      // the existing crash-resume test's approach of swapping in the real state_store call.
      o.start = async () => {
        const { appendTurnToSession } = await import('@/background/state_store');
        await appendTurnToSession(sessionId, 'task-fixed', 'the goal');
        return { phase: 'PLANNING' } as unknown;
      };
      o.runUntilTerminal = async () => {
        const { updateSessionTurnResult } = await import('@/background/state_store');
        await updateSessionTurnResult(sessionId, 'task-fixed', 'success', 'the answer');
        return { phase: 'DONE', verdict: 'success', summary: 'the answer', turns: 1, replans: 0 };
      };
      return o as unknown as Orchestrator;
    });

    void bg.handleStart('the goal');
    await flush();

    const sessions = await listSessions();
    const found = sessions.find((s) => s.id === sessionId)!;
    expect(found.turns[0]).toEqual({ taskId: 'task-fixed', goal: 'the goal', verdict: 'success', summary: 'the answer' });

    globalThis.fetch = origFetch;
    bg.setOrchestratorFactory(null);
  });
```

`listSessions` is already imported at the top of this test file (confirmed: `import { _setHot, listSessions, loadHot, patchHot } from '@/background/state_store';`) — no import changes needed for this step.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npx vitest run tests/unit/background_run_lifecycle.test.ts`
Expected: FAIL — `agent.start` doesn't auto-create a session yet, `handleSessionNew`/`handleSessionDelete` don't guard against a running task, and no `sessions` broadcast fires on finish.

- [ ] **Step 3: Update `handleSessionNew` and `handleSessionDelete` guards**

In `extension/src/background/index.ts`, find:

```ts
async function handleSessionNew() {
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

- [ ] **Step 4: Auto-create a session in `agent.start`, and re-broadcast sessions when a turn finishes**

In `extension/src/background/index.ts`, find the `agent.start` case in the port's `onMessage` switch:

```ts
          case 'agent.start':
            // Detached on purpose (NOT awaited). Chrome force-kills a single
            // onMessage handler at the 5-minute event-execution cap; a long
            // multi-step run (12b at ~14 t/s) blows past that. Returning from the
            // listener immediately ends the event, escaping the 5-min window — the
            // orchestrator then runs as a top-level task sustained by the 20s
            // keepalive, with no cumulative SW lifetime limit. handleStart has its
            // own try/catch/finally, so detaching loses no error handling.
            void handleStart(cmd.goal);
            break;
```

Replace with:

```ts
          case 'agent.start':
            // Auto-continue by default: a goal with no active session starts one, so a
            // follow-up goal naturally lands in the same chat without an explicit "New chat"
            // click first. Awaited (cheap IndexedDB write) BEFORE the detached handleStart below.
            if (!_activeSessionId) {
              const s = await createSession();
              _activeSessionId = s.id;
              await pushSessions();
            }
            // Detached on purpose (NOT awaited). Chrome force-kills a single
            // onMessage handler at the 5-minute event-execution cap; a long
            // multi-step run (12b at ~14 t/s) blows past that. Returning from the
            // listener immediately ends the event, escaping the 5-min window — the
            // orchestrator then runs as a top-level task sustained by the 20s
            // keepalive, with no cumulative SW lifetime limit. handleStart has its
            // own try/catch/finally, so detaching loses no error handling.
            void handleStart(cmd.goal);
            break;
```

Now find `handleStart`'s `finally` block:

```ts
  } finally {
    // Only tear down if WE are still the current run. After an abort/watchdog started a newer run,
    // this (now-stale) finally must not stop the new run's keepalive or null its _orch.
    if (myRun === _runId) {
      stopKeepAlive();
      _orch = null;
      _abortController = null;
      await pushStatus();
      await pushMetrics();
    }
  }
}
```

Replace with:

```ts
  } finally {
    // Only tear down if WE are still the current run. After an abort/watchdog started a newer run,
    // this (now-stale) finally must not stop the new run's keepalive or null its _orch.
    if (myRun === _runId) {
      stopKeepAlive();
      _orch = null;
      _abortController = null;
      await pushStatus();
      await pushMetrics();
      // The just-finished turn's verdict/summary landed in Session.turns via
      // updateSessionTurnResult (called from finishOk/abortNow, which runUntilTerminal already
      // awaited above) — push the refreshed session list so the panel's transcript picks it up.
      if (_activeSessionId) await pushSessions();
    }
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd extension && npx vitest run tests/unit/background_run_lifecycle.test.ts`
Expected: PASS — all tests in the `session commands` block green, including the 5 new ones.

- [ ] **Step 6: Run the full suite + typecheck**

Run: `cd extension && npm run typecheck && npx vitest run`
Expected: no errors, all tests pass.

- [ ] **Step 7: Commit**

```bash
cd extension && git add src/background/index.ts tests/unit/background_run_lifecycle.test.ts
git commit -m "feat(background): auto-create session on agent.start, guard session mutations mid-run, broadcast sessions on turn finish"
```

---

### Task 3: `renderRich` extraction + `SessionSwitcher` component

**Files:**
- Modify: `extension/src/sidepanel/view/format.ts`
- Modify: `extension/src/sidepanel/components/ResultCard.tsx`
- Create: `extension/src/sidepanel/components/SessionSwitcher.tsx`
- Modify: `extension/src/sidepanel/styles.css`
- Test: `extension/tests/unit/components_render.test.tsx`

- [ ] **Step 1: Move `renderRich` into `view/format.ts`**

In `extension/src/sidepanel/view/format.ts`, add at the top (after the existing header comment) — this needs `ReactNode`/`Fragment` from React:

```ts
// Pure formatting helpers for the panel.
import { Fragment, type ReactNode } from 'react';

/** Elapsed wall-clock: "0s", "59s", "1m 35s". Never negative. */
export function formatElapsed(ms: number): string {
```

(the `formatElapsed` function body stays exactly as-is; only the import line is added above it)

At the end of the file, after `describeVerdict`, add:

```ts

/** Lightweight rich rendering of an answer (no markdown dependency): normalize literal "\n"/"\t"
 *  some models emit as text, render **bold**, and keep real newlines (the container is pre-wrap). */
export function renderRich(text: string): ReactNode {
  const normalized = text.replace(/\\n/g, '\n').replace(/\\t/g, '  ');
  return normalized.split(/(\*\*[^*\n]+\*\*)/g).map((part, i) =>
    /^\*\*[^*\n]+\*\*$/.test(part) ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}
```

Since this file now contains JSX, rename it from `format.ts` to `format.tsx`:

```bash
cd extension && git mv src/sidepanel/view/format.ts src/sidepanel/view/format.tsx
```

- [ ] **Step 2: Update `ResultCard.tsx` to import `renderRich` instead of defining it**

In `extension/src/sidepanel/components/ResultCard.tsx`, find:

```ts
import { Fragment, type ReactNode, useState } from 'react';
import { describeVerdict, formatElapsed } from '../view/format';
import { Icon, type IconName } from './Icon';

/** Lightweight rich rendering of an answer (no markdown dependency): normalize literal "\n"/"\t"
 *  some models emit as text, render **bold**, and keep real newlines (the container is pre-wrap). */
function renderRich(text: string): ReactNode {
  const normalized = text.replace(/\\n/g, '\n').replace(/\\t/g, '  ');
  return normalized.split(/(\*\*[^*\n]+\*\*)/g).map((part, i) =>
    /^\*\*[^*\n]+\*\*$/.test(part) ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}
```

Replace with:

```ts
import { useState } from 'react';
import { describeVerdict, formatElapsed, renderRich } from '../view/format';
import { Icon, type IconName } from './Icon';
```

(All usages of `renderRich(...)` further down in `ResultCard.tsx` stay unchanged — only the definition moves.)

- [ ] **Step 3: Run the existing render tests to confirm the extraction didn't break anything**

Run: `cd extension && npx vitest run tests/unit/components_render.test.tsx`
Expected: PASS — the two existing `ResultCard` bold/verdict tests still pass unchanged, proving the extraction is behavior-preserving.

- [ ] **Step 4: Write the failing test for `SessionSwitcher`**

In `extension/tests/unit/components_render.test.tsx`, add to the imports:

```ts
import { SessionSwitcher } from '@/sidepanel/components/SessionSwitcher';
import type { Session } from '@/shared/messages';
```

Add this test inside the existing `describe('redesigned components render across states', ...)` block, after the `RecipesPanel` test:

```ts
  it('SessionSwitcher shows "New chat" when nothing is active, and lists past sessions once one exists', () => {
    const noneActive = renderToStaticMarkup(
      <SessionSwitcher sessions={[]} activeSessionId={null} onNew={noop} onSelect={noop} onDelete={noop} />,
    );
    expect(noneActive).toContain('New chat');

    const sessions: Session[] = [
      { id: 's1', title: 'find the population of Austin', createdAt: 1, lastActiveAt: 2, turns: [] },
      { id: 's2', title: 'compare two laptops', createdAt: 3, lastActiveAt: 4, turns: [] },
    ];
    const html = renderToStaticMarkup(
      <SessionSwitcher sessions={sessions} activeSessionId="s1" onNew={noop} onSelect={noop} onDelete={noop} />,
    );
    expect(html).toContain('find the population of Austin');
    expect(html).toContain('compare two laptops');
    expect(html).toMatch(/Delete/i); // active session has a delete affordance
  });
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `cd extension && npx vitest run tests/unit/components_render.test.tsx`
Expected: FAIL — `Cannot find module '@/sidepanel/components/SessionSwitcher'`.

- [ ] **Step 6: Create `SessionSwitcher.tsx`**

Create `extension/src/sidepanel/components/SessionSwitcher.tsx`:

```tsx
import type { Session } from '@/shared/messages';
import { Icon } from './Icon';

interface Props {
  sessions: Session[];
  activeSessionId: string | null;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

/** GPT-style chat switcher: pick a past session, start a new one, or delete the active one.
 *  Modeled on RecipesPanel's list pattern (select + row-between actions). */
export function SessionSwitcher({ sessions, activeSessionId, onNew, onSelect, onDelete }: Props) {
  const active = sessions.find((s) => s.id === activeSessionId);
  return (
    <div className="card session-switcher">
      <div className="row-between">
        <select
          className="recipe-select"
          value={activeSessionId ?? ''}
          onChange={(e) => onSelect(e.target.value)}
        >
          {!active && <option value="">New chat</option>}
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title || 'New chat'}
            </option>
          ))}
        </select>
        <div className="session-actions">
          <button className="btn btn-sm" onClick={onNew}>
            <Icon name="plus" size={12} /> New chat
          </button>
          {active && (
            <button className="btn btn-sm btn-danger" onClick={() => onDelete(active.id)}>
              <Icon name="x" size={12} /> Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Add CSS for the new classes**

In `extension/src/sidepanel/styles.css`, find the `.recipe-actions` rule:

```css
.recipe-actions { display: flex; gap: var(--sp-2); justify-content: flex-end; margin-top: var(--sp-3); }
```

Add immediately after it:

```css
.session-switcher { padding: var(--sp-3) var(--sp-4); }
.session-switcher .recipe-select { flex: 1; }
.session-actions { display: flex; gap: var(--sp-2); flex-shrink: 0; }
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd extension && npx vitest run tests/unit/components_render.test.tsx`
Expected: PASS.

- [ ] **Step 9: Typecheck**

Run: `cd extension && npm run typecheck`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
cd extension && git add src/sidepanel/view/format.tsx src/sidepanel/components/ResultCard.tsx src/sidepanel/components/SessionSwitcher.tsx src/sidepanel/styles.css tests/unit/components_render.test.tsx
git commit -m "feat(sidepanel): extract renderRich into view/format, add SessionSwitcher component"
```

---

### Task 4: `Transcript` component

**Files:**
- Create: `extension/src/sidepanel/components/Transcript.tsx`
- Modify: `extension/src/sidepanel/styles.css`
- Test: `extension/tests/unit/components_render.test.tsx`

- [ ] **Step 1: Write the failing test**

In `extension/tests/unit/components_render.test.tsx`, add to the imports:

```ts
import { Transcript } from '@/sidepanel/components/Transcript';
import type { SessionTurn } from '@/shared/messages';
```

Add this test after the `SessionSwitcher` test from Task 3:

```ts
  it('Transcript renders each past turn as goal + verdict + summary, and nothing when empty', () => {
    expect(renderToStaticMarkup(<Transcript turns={[]} />)).toBe('');

    const turns: SessionTurn[] = [
      { taskId: 't1', goal: 'find the population of Austin', verdict: 'success', summary: 'Austin has **961,855** residents.' },
      { taskId: 't2', goal: 'now do Seattle too' }, // no result yet — still mid-run or never finished
    ];
    const html = renderToStaticMarkup(<Transcript turns={turns} />);
    expect(html).toContain('find the population of Austin');
    expect(html).toContain('Success');
    expect(html).toContain('<strong>961,855</strong>');
    expect(html).toContain('now do Seattle too');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && npx vitest run tests/unit/components_render.test.tsx`
Expected: FAIL — `Cannot find module '@/sidepanel/components/Transcript'`.

- [ ] **Step 3: Create `Transcript.tsx`**

Create `extension/src/sidepanel/components/Transcript.tsx`:

```tsx
import type { SessionTurn } from '@/shared/messages';
import { describeVerdict, renderRich } from '../view/format';

/** Read-only history of every turn in the active session EXCEPT the current/most-recent one —
 *  that turn keeps getting the full RunState/ResultCard/Timeline treatment (see App.tsx), so
 *  duplicating it here would show the same answer twice. No interactivity: past turns are just
 *  scroll-back, not editable/re-runnable. */
export function Transcript({ turns }: { turns: SessionTurn[] }) {
  if (turns.length === 0) return null;
  return (
    <div className="transcript">
      {turns.map((t) => {
        const v = t.verdict != null ? describeVerdict(t.verdict) : null;
        return (
          <div key={t.taskId} className="transcript-turn">
            <div className="transcript-goal">{t.goal}</div>
            {t.summary != null && v != null && (
              <div className="transcript-result">
                <span className={`verdict ${v.tone}`}>{v.label}</span>
                <div className="transcript-summary">{renderRich(t.summary)}</div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Add CSS for the new classes**

In `extension/src/sidepanel/styles.css`, find the `.result-meta .copy-btn { margin-left: auto; }` line and add immediately after it:

```css
.transcript { display: flex; flex-direction: column; gap: var(--sp-3); }
.transcript-turn { padding: var(--sp-3) var(--sp-4); background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-card); }
.transcript-goal { font-size: 12.5px; font-weight: 600; color: var(--fg-mute); margin-bottom: var(--sp-2); }
.transcript-result { display: flex; flex-direction: column; gap: var(--sp-2); align-items: flex-start; }
.transcript-summary { font-size: 13px; line-height: 1.5; color: var(--fg); white-space: pre-wrap; word-break: break-word; }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd extension && npx vitest run tests/unit/components_render.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `cd extension && npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
cd extension && git add src/sidepanel/components/Transcript.tsx src/sidepanel/styles.css tests/unit/components_render.test.tsx
git commit -m "feat(sidepanel): add Transcript component for past-turn history"
```

---

### Task 5: Wire `App.tsx` — sessions state, reset-on-switch, render the new components

**Files:**
- Modify: `extension/src/sidepanel/App.tsx`

- [ ] **Step 1: Add `sessions`/`activeSessionId` state and imports**

In `extension/src/sidepanel/App.tsx`, update the top-level imports:

```ts
import type {
  AgentStatus,
  MetricsSnapshot,
  PanelCommand,
  RecipeView,
  Session,
  Settings,
  SwUpdate,
  TimelineEvent,
} from '@/shared/messages';
import { DEFAULT_SETTINGS } from '@/shared/messages';
import { createPortClient, type PortClient } from './port';
import { buildApplyGoal } from './apply';
import { isRunning } from './view/phase';
import { latestFinish } from './view/result';
import { Brand } from './components/Brand';
import { Tabs, type TabId } from './components/Tabs';
import { Composer } from './components/Composer';
import { SessionSwitcher } from './components/SessionSwitcher';
import { Transcript } from './components/Transcript';
import { RunState } from './components/RunState';
import { ResultCard } from './components/ResultCard';
import { Timeline } from './components/Timeline';
import { Alert } from './components/Alert';
import { ConnectionCard } from './components/ConnectionCard';
import { Icon } from './components/Icon';
import { SettingsPanel } from './components/SettingsPanel';
import { MetricsPanel } from './components/MetricsPanel';
import { RecipesPanel } from './components/RecipesPanel';
```

Inside the `App` function, after the existing `const [recipes, setRecipes] = useState<RecipeView[]>([]);` line, add:

```ts
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
```

- [ ] **Step 2: Handle the `sessions` SwUpdate**

In the `onUpdate` switch inside the connection `useEffect`, find the `case 'error':` branch:

```ts
        case 'error':
          setNotice({ msg: msg.message, kind: 'error' });
          break;
```

Add a new case immediately before it (order doesn't matter functionally, but keeping it near the other data-update cases like `recipes`/`metrics` reads better — insert right after the existing `case 'recipes':` block):

```ts
        case 'recipes':
          setRecipes(msg.recipes);
          break;
        case 'sessions':
          setSessions(msg.sessions);
          setActiveSessionId(msg.activeSessionId);
          break;
```

(This replaces the existing `case 'recipes': setRecipes(msg.recipes); break;` with the same case plus the new one right after — the `recipes` line itself is unchanged, just add `sessions` next to it.)

- [ ] **Step 3: Request the session list on mount**

Find:

```ts
    client.send({ type: 'settings.get' });
    client.send({ type: 'agent.status' });
    client.send({ type: 'models.list' });
    client.send({ type: 'preflight' }); // connection check on launch → surface the down-state immediately
```

Replace with:

```ts
    client.send({ type: 'settings.get' });
    client.send({ type: 'agent.status' });
    client.send({ type: 'models.list' });
    client.send({ type: 'session.list' });
    client.send({ type: 'preflight' }); // connection check on launch → surface the down-state immediately
```

- [ ] **Step 4: Reset the single-turn display when the active session changes**

After the existing "Surface the live activity automatically when a run starts" `useEffect`:

```ts
  // Surface the live activity automatically when a run starts.
  useEffect(() => {
    if (running) setActivityOpen(true);
  }, [running]);
```

Add a new effect. Track the previous session id with a ref so the FIRST `sessions` update (on mount, going from `null` to whatever session happens to already be active) doesn't wipe anything:

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

- [ ] **Step 5: Render `SessionSwitcher` and `Transcript`, and fall back to `Session.turns` for `ResultCard`**

Find the existing `finish`/`elapsedMs`/`stepCount`/`showEmpty` derivations right before the `return`:

```ts
  const finish = latestFinish(events);
  const elapsedMs = runStartedAt ? Math.max(0, now - runStartedAt) : 0;
  const stepCount = status.plan?.steps.length ?? null;
  const showEmpty = !running && events.length === 0;
```

Replace with:

```ts
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const pastTurns = (activeSession?.turns ?? []).slice(0, -1);
  const lastTurn = activeSession?.turns.at(-1);
  // Prefer live events (the turn just ran in THIS panel session); fall back to the session
  // record's own copy for a turn that finished in a previous panel session (events not in memory).
  const finish = latestFinish(events) ?? (lastTurn?.summary != null
    ? { verdict: lastTurn.verdict ?? '', summary: lastTurn.summary, sources: [] }
    : null);
  const elapsedMs = runStartedAt ? Math.max(0, now - runStartedAt) : 0;
  const stepCount = status.plan?.steps.length ?? null;
  const showEmpty = !running && events.length === 0 && pastTurns.length === 0 && !finish;
```

Now find the `tab === 'agent'` block:

```tsx
        {tab === 'agent' && (
          <>
            {ollamaDown && <ConnectionCard baseUrl={settings.ollamaBaseUrl} onRetry={handleRetry} />}

            <Composer
```

Replace with:

```tsx
        {tab === 'agent' && (
          <>
            {ollamaDown && <ConnectionCard baseUrl={settings.ollamaBaseUrl} onRetry={handleRetry} />}

            <SessionSwitcher
              sessions={sessions}
              activeSessionId={activeSessionId}
              onNew={() => send({ type: 'session.new' })}
              onSelect={(id) => send({ type: 'session.select', sessionId: id })}
              onDelete={(id) => send({ type: 'session.delete', sessionId: id })}
            />

            <Composer
```

Finally, find the block rendering `RunState`/`ResultCard`:

```tsx
            {notice && !ollamaDown && <Alert kind={notice.kind}>{notice.msg}</Alert>}

            {running && <RunState phase={status.phase} plan={status.plan} elapsedMs={elapsedMs} />}
```

Replace with:

```tsx
            {notice && !ollamaDown && <Alert kind={notice.kind}>{notice.msg}</Alert>}

            <Transcript turns={pastTurns} />

            {running && <RunState phase={status.phase} plan={status.plan} elapsedMs={elapsedMs} />}
```

- [ ] **Step 6: Run typecheck**

Run: `cd extension && npm run typecheck`
Expected: no errors. (Confirms `useRef` is already imported — it is, per the existing `clientRef`/`ref` usages in this file and `Composer.tsx`; `App.tsx`'s existing top import line already includes `useRef` via `import { useEffect, useRef, useState } from 'react';`.)

- [ ] **Step 7: Run the full test suite**

Run: `cd extension && npx vitest run`
Expected: PASS — all tests green (App.tsx itself has no dedicated test file per the existing project convention; this step confirms nothing else regressed).

- [ ] **Step 8: Manual verification in the browser**

Run: `cd extension && npm run build`

Load `extension/dist` as an unpacked extension in Chrome (chrome://extensions → Developer mode → Load unpacked), open the side panel, and verify:
1. With `ollama serve` running and models pulled, type a goal and run it. A session appears in the new switcher bar above the composer once the turn starts.
2. After it finishes, type a follow-up goal (don't click "New chat"). Confirm the follow-up lands in the same session (switcher still shows the same title) and the first turn's result now appears as a compact bubble in the transcript above the composer, while the second turn gets the full `RunState`/`ResultCard` treatment.
3. Click "New chat". Confirm the composer/result/transcript all clear.
4. Use the switcher's dropdown to go back to the first session. Confirm the transcript and the last turn's result reappear correctly (this is the `Session.turns` fallback path, since `events` was cleared by the "New chat" switch).
5. Click "Delete" on the currently-viewed session. Confirm it disappears from the dropdown and the panel returns to an empty/new-chat state.

- [ ] **Step 9: Commit**

```bash
cd extension && git add src/sidepanel/App.tsx
git commit -m "feat(sidepanel): wire SessionSwitcher + Transcript into App, auto-continue via active session"
```

---

### Task 6: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `cd extension && npx vitest run`
Expected: all tests pass, 0 failures (allow the 1 pre-existing skipped test, same as before this work started).

- [ ] **Step 2: Typecheck**

Run: `cd extension && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Build**

Run: `cd extension && npm run build`
Expected: succeeds, `extension/dist` produced.

- [ ] **Step 4: Grep for any remaining `turnIds` references**

Run: `cd extension && grep -rn "turnIds" src/ tests/`
Expected: no output (confirms Task 1 fully replaced every reference; if any remain outside this plan's known touch points, fix them before considering the plan done).

- [ ] **Step 5: Commit (if Step 4 required any fixes)**

Only if Step 4 found and required fixing something not already covered:

```bash
cd extension && git add -A
git commit -m "fix: clean up remaining turnIds references"
```
