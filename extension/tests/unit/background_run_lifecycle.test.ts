import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type TimelineEvent } from '@/shared/messages';
import type { Orchestrator } from '@/agent/orchestrator';
import { _testing as bg } from '@/background/index';
import { _setHot, listSessions, loadHot, patchHot } from '@/background/state_store';
import { resetStorage } from '../helpers';

// Drain pending micro+macrotasks so a detached handleStart can advance to its parked
// runUntilTerminal without us awaiting its (never-resolving) promise.
const flush = async (n = 14) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

interface FakeOrch {
  emit: ((ev: TimelineEvent) => void) | null;
  start: () => Promise<unknown>;
  runUntilTerminal: () => Promise<unknown>;
  abort: () => Promise<void>;
  finishRun: () => void;
}

function fakeOrch(): FakeOrch {
  let resolveRun!: () => void;
  const run = new Promise<unknown>((res) => {
    resolveRun = () => res({ phase: 'ABORTED', verdict: 'aborted', summary: '', turns: 0, replans: 0 });
  });
  return {
    emit: null,
    start: async () => ({ phase: 'PLANNING' }),
    runUntilTerminal: async () => run, // parked until finishRun()
    abort: async () => undefined,
    finishRun: () => resolveRun(),
  };
}

describe('background run lifecycle — a superseded run cannot tear down its successor', () => {
  let origFetch: typeof globalThis.fetch;
  const created: FakeOrch[] = [];

  beforeEach(async () => {
    await resetStorage();
    bg.reset();
    created.length = 0;
    origFetch = globalThis.fetch;
    // Preflight: ping ok + every required model present, so handleStart reaches the orchestrator.
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
      created.push(o);
      return o as unknown as Orchestrator;
    });
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    bg.setOrchestratorFactory(null);
    bg.reset();
  });

  it('abort → new start → the old run finishing leaves the new run intact (orch, keepalive, timeline)', async () => {
    void bg.handleStart('goal A');
    await flush();
    expect(bg.state().orchSet).toBe(true);
    expect(bg.state().keepAlive).toBe(true);
    expect(created.length).toBe(1);
    const runA = created[0];

    await bg.handleAbort();

    void bg.handleStart('goal B');
    await flush();
    expect(created.length).toBe(2);
    expect(bg.state().orchSet).toBe(true); // run B is now the live run
    const eventsBefore = bg.state().events;

    // Run A unwinds AFTER B is live, and emits one late event from its captured emit closure.
    runA.emit?.({ kind: 'log', ts: 1, level: 'info', message: 'late from the dead run A' });
    runA.finishRun();
    await flush();

    expect(bg.state().orchSet).toBe(true); // A's stale finally did NOT null B's orch
    expect(bg.state().keepAlive).toBe(true); // nor stop B's keepalive
    expect(bg.state().events).toBe(eventsBefore); // nor pollute B's timeline

    created[1].finishRun(); // let B settle so no promise dangles
    await flush();
  });
});

describe('crash-resume: SW restart finds an in-flight task', () => {
  beforeEach(async () => {
    await resetStorage();
    bg.reset();
  });

  it('marks the stale hot state ABORTED (not silently cleared to IDLE) so a panel connecting after the crash sees it', async () => {
    await _setHot('goal that was mid-flight when the SW died');
    await patchHot({ phase: 'EXECUTING' });

    await bg.crashResume();

    const hot = await loadHot();
    expect(hot).not.toBeNull(); // still present — a connecting panel must be able to read it
    expect(hot?.phase).toBe('ABORTED'); // not absent/IDLE
  });

  it('is a no-op when there is no in-flight task (fresh IDLE start, or already DONE/ABORTED)', async () => {
    expect(await loadHot()).toBeNull();
    await bg.crashResume(); // must not throw on a missing hot record
    expect(await loadHot()).toBeNull();
  });

  it('the lingering ABORTED does not persist forever — the next real agent.start overwrites it', async () => {
    await _setHot('goal that was mid-flight when the SW died');
    await patchHot({ phase: 'EXECUTING' });
    await bg.crashResume();
    expect((await loadHot())?.phase).toBe('ABORTED');

    const models = [
      DEFAULT_SETTINGS.executorModel,
      DEFAULT_SETTINGS.plannerModel,
      DEFAULT_SETTINGS.evaluatorModel,
      DEFAULT_SETTINGS.compactorModel,
    ].map((name) => ({ name }));
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ models }) }) as Response) as typeof globalThis.fetch;
    const created: FakeOrch[] = [];
    bg.setOrchestratorFactory((opts) => {
      const o = fakeOrch();
      o.emit = opts.emit;
      // The real Orchestrator.start() is what calls the real _setHot (an unconditional overwrite)
      // — that's the actual mechanism that must clear a lingering ABORTED, so exercise it here
      // instead of the fake's static stub.
      o.start = async () => _setHot('a brand new goal, started by the user after the crash');
      created.push(o);
      return o as unknown as Orchestrator;
    });

    try {
      void bg.handleStart('a brand new goal, started by the user after the crash');
      await flush();

      const hotAfterStart = await loadHot();
      expect(hotAfterStart?.phase).not.toBe('ABORTED'); // overwritten by the fresh task
      expect(hotAfterStart?.goal).toBe('a brand new goal, started by the user after the crash');

      created[0].finishRun();
      await flush();
    } finally {
      globalThis.fetch = origFetch;
      bg.setOrchestratorFactory(null);
    }
  });
});

describe('session commands', () => {
  beforeEach(async () => {
    await resetStorage();
    bg.reset();
  });

  it('handleSessionNew creates a session and makes it active', async () => {
    await bg.handleSessionNew();
    const sessions = await listSessions();
    expect(sessions.length).toBe(1);
    expect(bg.state().activeSessionId).toBe(sessions[0].id);
  });

  it('handleSessionSelect switches the active session', async () => {
    await bg.handleSessionNew();
    const first = bg.state().activeSessionId;
    await bg.handleSessionNew();
    const second = bg.state().activeSessionId;
    expect(second).not.toBe(first);

    await bg.handleSessionSelect(first!);
    expect(bg.state().activeSessionId).toBe(first);
  });

  it('handleSessionSelect refuses to switch while a task is running', async () => {
    await bg.handleSessionNew();
    const first = bg.state().activeSessionId;
    await bg.handleSessionNew();
    const second = bg.state().activeSessionId;

    // Simulate a running task the way the existing lifecycle tests do (a fake orchestrator
    // that never resolves runUntilTerminal until finishRun() is called, and a fetch stub so
    // handleStart's preflight — ping + listModels, both real fetch() calls — succeeds).
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

    await bg.handleSessionSelect(first!);
    expect(bg.state().activeSessionId).toBe(second); // unchanged — refused while orchSet

    liveOrch!.finishRun();
    await flush();
    globalThis.fetch = origFetch;
    bg.setOrchestratorFactory(null);
  });

  it('handleSessionDelete removes it and clears activeSessionId if it was active', async () => {
    await bg.handleSessionNew();
    const id = bg.state().activeSessionId!;
    await bg.handleSessionDelete(id);
    expect(await listSessions()).toEqual([]);
    expect(bg.state().activeSessionId).toBeNull();
  });

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
});
