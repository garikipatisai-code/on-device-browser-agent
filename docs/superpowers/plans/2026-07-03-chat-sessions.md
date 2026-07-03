# Chat-Based Sessions + Session Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a follow-up goal continue in the same "session" as a prior one — carrying forward the grounded facts ledger and last summary into the next turn's prompts — with session history (create/list/select/delete) as the backend surface a chat-style UI can be built against later.

**Architecture:** A **session** groups an ordered list of **turns** (today's existing `Orchestrator` runs, unchanged internally). Two new IndexedDB stores (`sessions`, `sessionContext`) hold the session list and its carried-forward context; `Orchestrator.start()` gains an optional `sessionId` parameter that seeds `facts`/`priorSummary` from that context instead of starting empty, and writes back on every terminal state. Four new `PanelCommand` types expose session CRUD to the side panel.

**Tech Stack:** TypeScript, IndexedDB (via the existing `idb` wrapper in `state_store.ts`), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-03-chat-sessions-design.md`

---

### Task 1: `Session` + `SessionContext` stores and CRUD in `state_store.ts`

**Files:**
- Modify: `extension/src/background/state_store.ts`
- Test: `extension/tests/unit/state_store.test.ts`

- [ ] **Step 1: Write the failing tests**

Add this new `describe` block to `extension/tests/unit/state_store.test.ts`, after the closing `});` of the existing `describe('scratchpad + memory + events', ...)` block:

```ts
describe('sessions', () => {
  it('creates, lists, and deletes a session', async () => {
    const s1 = await createSession();
    const s2 = await createSession();
    const listed = await listSessions();
    expect(listed.map((s) => s.id).sort()).toEqual([s1.id, s2.id].sort());
    expect(s1.title).toBe('');
    expect(s1.turnIds).toEqual([]);

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

  it('appendTurnToSession appends the taskId and sets the title from the first turn only', async () => {
    const s = await createSession();
    await appendTurnToSession(s.id, 'task-1', 'find the population of Austin');
    await appendTurnToSession(s.id, 'task-2', 'now do Seattle too');
    const listed = await listSessions();
    const found = listed.find((x) => x.id === s.id)!;
    expect(found.turnIds).toEqual(['task-1', 'task-2']);
    expect(found.title).toBe('find the population of Austin');
  });

  it('truncates a long goal to build the title', async () => {
    const s = await createSession();
    const longGoal = 'x'.repeat(200);
    await appendTurnToSession(s.id, 'task-1', longGoal);
    const listed = await listSessions();
    expect(listed[0].title.length).toBeLessThanOrEqual(80);
  });
});

describe('sessionContext', () => {
  it('a session with no saved context loads as empty facts + empty summary', async () => {
    const s = await createSession();
    const ctx = await loadSessionContext(s.id);
    expect(ctx).toEqual({ sessionId: s.id, facts: [], lastSummary: '', updatedAt: 0 });
  });

  it('round-trips facts and a summary', async () => {
    const s = await createSession();
    const facts = [{ step: 'step-1', text: 'Austin population: 961,855' }];
    await saveSessionContext(s.id, facts, 'success: Austin has 961,855 residents');
    const ctx = await loadSessionContext(s.id);
    expect(ctx.facts).toEqual(facts);
    expect(ctx.lastSummary).toBe('success: Austin has 961,855 residents');
    expect(ctx.updatedAt).toBeGreaterThan(0);
  });

  it('caps lastSummary at 500 chars', async () => {
    const s = await createSession();
    const long = 'y'.repeat(1000);
    await saveSessionContext(s.id, [], long);
    const ctx = await loadSessionContext(s.id);
    expect(ctx.lastSummary.length).toBe(500);
  });
});
```

Add these imports to the top of the test file (merge into the existing `import { ... } from '@/background/state_store';` block — check the file first and add these names to whatever's already being destructured from that import):

```ts
createSession,
listSessions,
deleteSession,
appendTurnToSession,
loadSessionContext,
saveSessionContext,
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npx vitest run tests/unit/state_store.test.ts -t "sessions"`
Expected: FAIL — none of `createSession`/`listSessions`/`deleteSession`/`appendTurnToSession`/`loadSessionContext`/`saveSessionContext` exist yet.

- [ ] **Step 3: Add the `Session`/`SessionContext` types, bump `DB_VERSION`, add the two stores**

`Session` needs to be usable from `shared/messages.ts` (it travels over the port inside a future `SwUpdate`, added in Task 4) — following this codebase's existing precedent for that exact situation (`RecipeView` in `messages.ts` mirrors `workflow_memory.ts`'s `Workflow` record; `AgentStatus` in `messages.ts` mirrors `state_store.ts`'s own `AgentStateHot`), `Session` is defined in `shared/messages.ts` and `state_store.ts` imports it — never the reverse, since every existing `state_store.ts` import already flows that one direction. `SessionContext` never crosses the port, so it stays local to `state_store.ts` alongside `FindingRecord`/`EventRecord`/etc.

In `extension/src/shared/messages.ts`, add near `RecipeView` (same "UI/cross-boundary record" grouping):

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

In `extension/src/background/state_store.ts`, find the top-level imports:

```ts
import type {
  AgentStatus,
  DomainTier,
  Plan,
  Settings,
  TaskPhase,
  TimelineEvent,
} from '@/shared/messages';
```

Add `Session` and `Fact` (the latter needed for `SessionContext.facts`):

```ts
import type {
  AgentStatus,
  DomainTier,
  Plan,
  Session,
  Settings,
  TaskPhase,
  TimelineEvent,
} from '@/shared/messages';
import type { Fact } from '@/agent/facts';
```

Find `AgentStateHot`'s interface block and add nothing there yet (session tracking lives in the new stores, not hot state — hot state stays scoped to the single active run, same as today).

Find the DB setup:

```ts
const DB_NAME = 'browser-agent';
const DB_VERSION = 1;
```

Replace with:

```ts
const DB_NAME = 'browser-agent';
const DB_VERSION = 2;
```

Find the `upgrade(d)` callback inside `openDB(DB_NAME, DB_VERSION, { upgrade(d) { ... } })` and add two more `if` blocks after the existing `scratchpad` one:

```ts
      if (!d.objectStoreNames.contains('scratchpad')) {
        d.createObjectStore('scratchpad', { keyPath: 'taskId' });
      }
      if (!d.objectStoreNames.contains('sessions')) {
        d.createObjectStore('sessions', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('sessionContext')) {
        d.createObjectStore('sessionContext', { keyPath: 'sessionId' });
      }
```

Add the `SessionContext` interface and CRUD functions (both `Session` and `SessionContext`'s CRUD live here, since this is where every other store's CRUD already lives — only the `Session` *type itself* moved to `messages.ts`) right after the existing `getScratchpad` function (before `export async function recordMetric`):


```ts
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
    turnIds: [],
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

/** Appends a turn's taskId to the session, sets the title from the FIRST turn's goal only
 *  (subsequent turns don't overwrite it), and bumps lastActiveAt. */
export async function appendTurnToSession(sessionId: string, taskId: string, goal?: string): Promise<void> {
  const d = await db();
  const cur = (await d.get('sessions', sessionId)) as Session | undefined;
  if (!cur) return;
  const next: Session = {
    ...cur,
    turnIds: [...cur.turnIds, taskId],
    title: cur.title || (goal ?? '').slice(0, SESSION_TITLE_MAX),
    lastActiveAt: Date.now(),
  };
  await d.put('sessions', next);
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

export async function saveSessionContext(sessionId: string, facts: Fact[], lastSummary: string): Promise<void> {
  try {
    const d = await db();
    await d.put('sessionContext', {
      sessionId,
      facts,
      lastSummary: lastSummary.slice(0, SESSION_SUMMARY_MAX),
      updatedAt: Date.now(),
    });
  } catch {
    /* best-effort, same pattern as setScratchpad/recordMetric */
  }
}
```

This file doesn't currently import `ulid` — add it to the top-level imports (right after the `idb` import):

```ts
import { openDB, type IDBPDatabase } from 'idb';
import { ulid } from '@/agent/util';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && npx vitest run tests/unit/state_store.test.ts`
Expected: All tests PASS, including the new `sessions`/`sessionContext` blocks.

- [ ] **Step 5: Run typecheck**

Run: `cd extension && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extension/src/background/state_store.ts extension/tests/unit/state_store.test.ts
git commit -m "feat(state_store): add Session + SessionContext IndexedDB stores"
```

---

### Task 2: `CommonContext.priorSummary` + `priorSummaryBlock`

**Files:**
- Modify: `extension/src/agent/prompts/index.ts`
- Test: `extension/tests/unit/prompts_common.test.ts` (create if it doesn't already exist — check first; if a `prompts_*.test.ts` file already covers `buildPlannerMessages`/`buildEvaluatorMessages`, add to that one instead of creating a new file)

- [ ] **Step 1: Check for an existing prompts test file**

Run: `cd extension && ls tests/unit/ | grep -i prompt`

If a file testing `buildPlannerMessages` or `preferencesBlock`-style helpers already exists, use it for Step 2 below instead of creating `prompts_common.test.ts`. If none exists, create `extension/tests/unit/prompts_common.test.ts`.

- [ ] **Step 2: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { buildPlannerMessages, buildEvaluatorMessages, type CommonContext } from '@/agent/prompts';

const baseCtx: CommonContext = {
  goal: 'test goal',
  toolCatalog: 'tool: echo',
  plan: null,
  currentStepId: null,
  ownedTabs: [],
};

describe('priorSummary in prompts', () => {
  it('buildPlannerMessages omits the prior-turn block when priorSummary is absent', () => {
    const msgs = buildPlannerMessages(baseCtx);
    const user = msgs.find((m) => m.role === 'user')!.content;
    expect(user).not.toContain('PRIOR TURN IN THIS SESSION');
  });

  it('buildPlannerMessages includes the prior-turn block when priorSummary is set', () => {
    const msgs = buildPlannerMessages({ ...baseCtx, priorSummary: 'success: Austin has 961,855 residents' });
    const user = msgs.find((m) => m.role === 'user')!.content;
    expect(user).toContain('PRIOR TURN IN THIS SESSION');
    expect(user).toContain('Austin has 961,855 residents');
  });

  it('buildEvaluatorMessages includes the prior-turn block when priorSummary is set', () => {
    const step = { id: 's1', description: 'd', successCriteria: 'c', status: 'active' as const };
    const msgs = buildEvaluatorMessages(
      { ...baseCtx, priorSummary: 'success: Austin has 961,855 residents' },
      'executor result',
      step,
    );
    const user = msgs.find((m) => m.role === 'user')!.content;
    expect(user).toContain('PRIOR TURN IN THIS SESSION');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd extension && npx vitest run tests/unit/prompts_common.test.ts` (or whichever file you used)
Expected: FAIL — `priorSummary` isn't a recognized field yet and no block is rendered for it (the "omits" test may pass trivially, but the "includes" tests fail since nothing renders the text).

- [ ] **Step 4: Implement**

In `extension/src/agent/prompts/index.ts`, find:

```ts
export interface CommonContext {
  goal: string;
  toolCatalog: string;
  plan: Plan | null;
  currentStepId: string | null;
  ownedTabs: number[];
  findingsBlock?: string;
  scratchpad?: string;
  recentActions?: string;
  pageContentBlock?: string;
  profileBlock?: string;
  /** Corrections the user injected mid-task ("steer"). Surfaced as high-priority guidance. */
  steerNotes?: string[];
  /** Durable user-set preferences (USER.md analog), injected into every run. */
  preferences?: string;
}
```

Replace with:

```ts
export interface CommonContext {
  goal: string;
  toolCatalog: string;
  plan: Plan | null;
  currentStepId: string | null;
  ownedTabs: number[];
  findingsBlock?: string;
  scratchpad?: string;
  recentActions?: string;
  pageContentBlock?: string;
  profileBlock?: string;
  /** Corrections the user injected mid-task ("steer"). Surfaced as high-priority guidance. */
  steerNotes?: string[];
  /** Durable user-set preferences (USER.md analog), injected into every run. */
  preferences?: string;
  /** The prior turn's finish summary, carried forward within the same chat session. */
  priorSummary?: string;
}
```

Find:

```ts
function preferencesBlock(preferences?: string): string {
  const p = (preferences ?? '').trim();
  if (!p) return '';
  return `STANDING PREFERENCES (the user's persistent guidance — honor it unless the GOAL says otherwise):\n${p}`;
}
```

Add right after it:

```ts
function priorSummaryBlock(summary?: string): string {
  const s = (summary ?? '').trim();
  if (!s) return '';
  return `PRIOR TURN IN THIS SESSION (for continuity — the current GOAL may reference "it", "that", "the same site", etc.):\n${s}`;
}
```

Find `buildPlannerMessages`'s `user` array:

```ts
  const user = [
    `GOAL: ${ctx.goal}`,
    preferencesBlock(ctx.preferences),
    steerBlock(ctx.steerNotes),
    workflowRecipe ? `PROVEN RECIPE (a known-good sequence for a task like this — build your plan from it):\n${workflowRecipe}` : '',
    `TOOLS:\n${ctx.toolCatalog}`,
    SAFETY_RULES,
    tabsList(ctx.ownedTabs),
    planText(ctx.plan, ctx.currentStepId),
    extra ? `REPLAN CONTEXT:\n${extra}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
```

Replace with:

```ts
  const user = [
    `GOAL: ${ctx.goal}`,
    preferencesBlock(ctx.preferences),
    priorSummaryBlock(ctx.priorSummary),
    steerBlock(ctx.steerNotes),
    workflowRecipe ? `PROVEN RECIPE (a known-good sequence for a task like this — build your plan from it):\n${workflowRecipe}` : '',
    `TOOLS:\n${ctx.toolCatalog}`,
    SAFETY_RULES,
    tabsList(ctx.ownedTabs),
    planText(ctx.plan, ctx.currentStepId),
    extra ? `REPLAN CONTEXT:\n${extra}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
```

Now find `buildEvaluatorMessages`. Read its `user`/`lines` array construction (it's a separate function, further down the file) and add `priorSummaryBlock(ctx.priorSummary)` into its array in the same relative position (right after wherever `preferencesBlock`/`steerBlock` appear in that function — check the actual current array contents before editing, since this plan doesn't have its exact text in front of it; match the same insertion logic used above: after `preferencesBlock`, before `steerBlock`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd extension && npx vitest run tests/unit/prompts_common.test.ts`
Expected: All tests PASS.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `cd extension && npm run typecheck && npx vitest run`
Expected: Both clean — this confirms adding an optional field to `CommonContext` didn't break any existing prompt-building test.

- [ ] **Step 7: Commit**

```bash
git add extension/src/agent/prompts/index.ts extension/tests/unit/prompts_common.test.ts
git commit -m "feat(prompts): add priorSummary context field for session continuation"
```

(If you added to an existing test file instead of creating `prompts_common.test.ts`, `git add` that file's actual path instead.)

---

### Task 3: `Orchestrator.start()` accepts a session, carries facts/summary forward, writes back on finish

**Files:**
- Modify: `extension/src/agent/orchestrator.ts`
- Test: `extension/tests/integration/orchestrator.test.ts`

- [ ] **Step 1: Write the failing test**

Add this new `describe` block to `extension/tests/integration/orchestrator.test.ts`, after the closing `});` of the last existing `describe` block in the file:

```ts
describe('orchestrator — session continuation', () => {
  it('carries a grounded fact from turn 1 into turn 2 of the same session, with no re-observation', async () => {
    const session = await createSession();

    const reg = buildRegistry();
    let ariaCalls = 0;
    reg.register({
      name: 'aria.extract',
      description: 'extract the page',
      argsSchema: z.object({ tabId: z.number().int().optional() }),
      async dispatch() {
        ariaCalls += 1;
        return { ok: true, content: 'City Alpha population: 111,111 residents', data: { url: 'https://cities.test/alpha' } };
      },
    });

    // Turn 1: reads the page, finds the fact, finishes.
    const ollama1 = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'read city alpha', successCriteria: 'population reported' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'City Alpha population: 111,111' } }] }),
      ],
      evaluator: [],
    });
    const orch1 = new Orchestrator({ ollama: ollama1, registry: reg, settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const initial1 = await orch1.start('find city alpha population', session.id);
    const result1 = await orch1.runUntilTerminal(initial1);
    expect(result1.phase).toBe('DONE');

    // Turn 2, same session: asks a follow-up that only makes sense with turn 1's fact carried
    // forward. No aria.extract call is scripted for the executor this turn — if the fact isn't
    // carried into the grounding corpus, the finish would be rejected as ungrounded and the test's
    // executor queue would run dry (makeFakeOllama returns {} which fails toolCall parsing).
    const execPrompts2: string[] = [];
    const ollama2 = makeFakeOllama(
      {
        planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'report the population again', successCriteria: 'population reported' }] }) })],
        executor: [
          rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'City Alpha population: 111,111' } }] }),
        ],
        evaluator: [],
      },
      { onChat: (_m, role, messages) => { if (role === 'planner') execPrompts2.push(JSON.stringify(messages)); } },
    );
    const orch2 = new Orchestrator({ ollama: ollama2, registry: reg, settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const initial2 = await orch2.start('what was the population again?', session.id);
    const result2 = await orch2.runUntilTerminal(initial2);

    expect(result2.phase).toBe('DONE');
    expect(result2.verdict).toBe('success');
    // Turn 2's planner prompt must contain turn 1's carried summary.
    expect(execPrompts2.join('\n')).toContain('111,111');
    // No re-observation happened in turn 2 (only 1 aria.extract call total, from turn 1).
    expect(ariaCalls).toBe(1);

    const finalSessions = await listSessions();
    const finalSession = finalSessions.find((s) => s.id === session.id)!;
    expect(finalSession.turnIds.length).toBe(2);
  });

  it('a turn started with no sessionId behaves exactly as before (byte-identical baseline)', async () => {
    const reg = buildRegistry();
    reg.register({
      name: 'aria.extract',
      description: 'extract the page',
      argsSchema: z.object({ tabId: z.number().int().optional() }),
      async dispatch() {
        return { ok: true, content: 'City Alpha population: 111,111 residents', data: { url: 'https://cities.test/alpha' } };
      },
    });
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'read city alpha', successCriteria: 'population reported' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'City Alpha population: 111,111' } }] }),
      ],
      evaluator: [],
    });
    const orch = new Orchestrator({ ollama, registry: reg, settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    // No sessionId argument at all — matches every pre-session call site (agent.start today).
    const initial = await orch.start('find city alpha population');
    const result = await orch.runUntilTerminal(initial);
    expect(result.phase).toBe('DONE');
    expect(result.verdict).toBe('success');
  });
});
```

Add these imports to the top of `extension/tests/integration/orchestrator.test.ts` (merge into the existing `@/background/state_store` import):

```ts
createSession,
listSessions,
```

- [ ] **Step 2: Run the tests to verify the session one fails**

Run: `cd extension && npx vitest run tests/integration/orchestrator.test.ts -t "session continuation"`
Expected: the "carries a grounded fact" test FAILS (either a type error on `orch1.start('...', session.id)` since `start()` doesn't accept a second argument yet, or — once that's stubbed to accept and ignore it — the turn-2 finish gets rejected as ungrounded since nothing carries `111,111` forward). The "no sessionId" test should already PASS (it's a pure regression/characterization check of already-correct behavior).

- [ ] **Step 3: Implement**

In `extension/src/agent/orchestrator.ts`, add two new imports. Find:

```ts
import { ulid } from './util';
```

(Check the exact existing import line for `ulid` — it's combined with other names, e.g. `import { actionHash, TokenRatioEstimator, ulid } from './util';`. Do not duplicate the import; just add the new names below to a NEW import line for `state_store` additions.)

Find the existing `state_store` import block (it starts with `_setHot,` and similar names) and add these two names to it:

```ts
appendTurnToSession,
loadSessionContext,
saveSessionContext,
```

Add two new private fields. Find:

```ts
  private observedText = '';
  private facts: Fact[] = [];
```

Replace with:

```ts
  private observedText = '';
  private facts: Fact[] = [];
  private sessionId: string | null = null;
  private priorSummary = '';
```

Find the `start()` method:

```ts
  async start(goal: string): Promise<AgentStateHot> {
    const trimmed = goal.trim();
    if (!trimmed) throw new Error('goal is empty');
    this.est.reset();
    this.breaker = newBreakerState();
    this.recentActions = [];
    this.lastRead = null;
    this.observedText = '';
    this.facts = [];
    this.verifyAttempts = 0;
    this.turns = 0;
    this.consecutiveFatal = 0;
    this.sawActionDenial = false;
    this.lastObserveTool = null;
    this.observeGateStep = null;
    clearSearchResults(); // don't let a prior task's results ground/block this one
    this.trace = [];
    this.sourceUrls = new Set();
    this.steerNotes = [];
    this.runDirty = false;
    this.dirtyReason = '';
    this.matchedWorkflow = matchWorkflow(trimmed, await loadWorkflows());
    this.taskId = ulid();
    this.numCtx = clampNumCtx(this.opts.settings.numCtx);
    this.caps = capsFor(this.numCtx);
    const hot = await _setHot(trimmed);
    await setScratchpad(this.taskId, '');
    this.log('info', `Task started: ${trimmed}`);
    if (this.matchedWorkflow) this.log('info', `Workflow recipe matched: ${this.matchedWorkflow.id}`);
    return hot;
```

Replace with:

```ts
  async start(goal: string, sessionId?: string | null): Promise<AgentStateHot> {
    const trimmed = goal.trim();
    if (!trimmed) throw new Error('goal is empty');
    this.est.reset();
    this.breaker = newBreakerState();
    this.recentActions = [];
    this.lastRead = null;
    this.observedText = '';
    this.verifyAttempts = 0;
    this.turns = 0;
    this.consecutiveFatal = 0;
    this.sawActionDenial = false;
    this.lastObserveTool = null;
    this.observeGateStep = null;
    clearSearchResults(); // don't let a prior task's results ground/block this one
    this.trace = [];
    this.sourceUrls = new Set();
    this.steerNotes = [];
    this.runDirty = false;
    this.dirtyReason = '';
    this.matchedWorkflow = matchWorkflow(trimmed, await loadWorkflows());
    this.taskId = ulid();
    this.numCtx = clampNumCtx(this.opts.settings.numCtx);
    this.caps = capsFor(this.numCtx);
    this.sessionId = sessionId ?? null;
    if (this.sessionId) {
      const carried = await loadSessionContext(this.sessionId);
      this.facts = carried.facts;
      this.priorSummary = carried.lastSummary;
      await appendTurnToSession(this.sessionId, this.taskId, trimmed);
    } else {
      this.facts = [];
      this.priorSummary = '';
    }
    const hot = await _setHot(trimmed);
    await setScratchpad(this.taskId, '');
    this.log('info', `Task started: ${trimmed}`);
    if (this.matchedWorkflow) this.log('info', `Workflow recipe matched: ${this.matchedWorkflow.id}`);
    return hot;
```

Find `commonCtx()`:

```ts
  private commonCtx(hot: AgentStateHot, scratchpad?: string) {
    return {
      goal: hot.goal,
      toolCatalog: this.opts.registry.describe(),
      plan: hot.plan,
      currentStepId: hot.currentStepId,
      ownedTabs: hot.ownedTabs,
      scratchpad,
      profileBlock: renderProfileBlock(this.opts.settings.profileJson),
      steerNotes: this.steerNotes.length ? [...this.steerNotes] : undefined,
      preferences: (this.opts.settings.preferences ?? '').trim() || undefined,
      pageContentBlock: this.lastRead
```

Add `priorSummary` right after `preferences`:

```ts
  private commonCtx(hot: AgentStateHot, scratchpad?: string) {
    return {
      goal: hot.goal,
      toolCatalog: this.opts.registry.describe(),
      plan: hot.plan,
      currentStepId: hot.currentStepId,
      ownedTabs: hot.ownedTabs,
      scratchpad,
      profileBlock: renderProfileBlock(this.opts.settings.profileJson),
      steerNotes: this.steerNotes.length ? [...this.steerNotes] : undefined,
      preferences: (this.opts.settings.preferences ?? '').trim() || undefined,
      priorSummary: this.priorSummary || undefined,
      pageContentBlock: this.lastRead
```

Find `finishOk`:

```ts
  private async finishOk(
    hot: AgentStateHot,
    verdict: string,
    summary: string,
  ): Promise<RunResult> {
    await this.cleanupTabs(hot);
    await patchHot({ phase: 'DONE' });
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
    if (this.sessionId) await saveSessionContext(this.sessionId, this.facts, `${verdict}: ${summary}`);
```

Find `abortNow`:

```ts
  private async abortNow(hot: AgentStateHot, reason: string): Promise<RunResult> {
    await this.cleanupTabs(hot);
    await patchHot({ phase: 'ABORTED' });
```

Replace with:

```ts
  private async abortNow(hot: AgentStateHot, reason: string): Promise<RunResult> {
    await this.cleanupTabs(hot);
    await patchHot({ phase: 'ABORTED' });
    if (this.sessionId) await saveSessionContext(this.sessionId, this.facts, `aborted: ${reason}`);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && npx vitest run tests/integration/orchestrator.test.ts`
Expected: All tests PASS, including both new session-continuation tests.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `cd extension && npm run typecheck && npx vitest run`
Expected: Both clean — 0 regressions in the rest of the suite. This is the concrete proof of the spec's "byte-identical baseline" guarantee: every existing test calls `orch.start(goal)` with no second argument, so `sessionId` stays `null` and behavior is unchanged.

- [ ] **Step 6: Commit**

```bash
git add extension/src/agent/orchestrator.ts extension/tests/integration/orchestrator.test.ts
git commit -m "feat(orchestrator): carry session facts/summary across turns via an optional sessionId"
```

---

### Task 4: `PanelCommand`/`SwUpdate` session types + `background/index.ts` wiring

**Files:**
- Modify: `extension/src/shared/messages.ts`
- Modify: `extension/src/background/index.ts`
- Test: `extension/tests/unit/background_run_lifecycle.test.ts`

- [ ] **Step 1: Write the failing test**

`background_run_lifecycle.test.ts` has **no port-message-simulation harness** — every existing test drives `background/index.ts` by calling named functions exposed through its `_testing` export (`bg.handleStart(...)`, `bg.handleAbort()`, `bg.crashResume()`) and inspects effects via `bg.state()` or by reading storage directly (`loadHot()`). Match that exact pattern — don't invent a port/broadcast-capture helper.

Add this new `describe` block at the end of `extension/tests/unit/background_run_lifecycle.test.ts`:

```ts
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
});
```

Add `listSessions` to the top-of-file import from `@/background/state_store`:

```ts
import { _setHot, listSessions, loadHot, patchHot } from '@/background/state_store';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && npx vitest run tests/unit/background_run_lifecycle.test.ts -t "session commands"`
Expected: FAIL — `bg.handleSessionNew`/`handleSessionSelect`/`handleSessionDelete` don't exist yet, and `bg.state()` doesn't return `activeSessionId` yet.

- [ ] **Step 3: Add the PanelCommand/SwUpdate types**

In `extension/src/shared/messages.ts`, find the `PanelCommand` union:

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
  | { type: 'preflight' };
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
  | { type: 'session.delete'; sessionId: string };
```

Find the `SwUpdate` union:

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
  | { type: 'error'; message: string };
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
  | { type: 'sessions'; sessions: Session[]; activeSessionId: string | null };
```

`Session` needs no new import here — it's the same type already defined directly in this file back in Task 1's Step 3, right next to `RecipeView`.

- [ ] **Step 4: Wire the four new cases into `background/index.ts`**

In `extension/src/background/index.ts`, add a new module-level variable near the other module-level state. Find:

```ts
let _orch: Orchestrator | null = null;
```

Add right after the block of `let _events`/`_panels` declarations (i.e. after `const _panels = new Set<chrome.runtime.Port>();`):

```ts
let _activeSessionId: string | null = null;
```

Add the import for the new state_store functions and `Session` type. Find:

```ts
import {
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
  loadHot,
  loadSettings,
  patchHot,
  saveResumeFile,
  saveSettings,
  setDomainTier,
  toStatus,
} from './state_store';
```

Add a small helper function near `pushRecipes` (same pattern — load then broadcast). Find:

```ts
async function pushRecipes() {
  broadcast({ type: 'recipes', recipes: await listRecipeViews() });
}
```

Add right after it, plus the three named handler functions (same shape as the existing `handleAbort` — a standalone `async function`, not inline switch-case logic, so they're independently testable via `_testing` exactly like `handleAbort` already is):

```ts
async function pushSessions() {
  broadcast({ type: 'sessions', sessions: await listSessions(), activeSessionId: _activeSessionId });
}

async function handleSessionNew() {
  const s = await createSession();
  _activeSessionId = s.id;
  await pushSessions();
}

async function handleSessionSelect(sessionId: string) {
  if (_orch) {
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

Find the `handleStart` function's call to `_orch.start(goal)`:

```ts
    const initial = await _orch.start(goal);
```

Replace with:

```ts
    const initial = await _orch.start(goal, _activeSessionId);
```

Find the port's command switch statement. Find:

```ts
          case 'agent.status':
            await pushStatus();
            break;
```

Add the four new cases right after it, delegating to the named functions above:

```ts
          case 'agent.status':
            await pushStatus();
            break;
          case 'session.new':
            await handleSessionNew();
            break;
          case 'session.list':
            await pushSessions();
            break;
          case 'session.select':
            await handleSessionSelect(cmd.sessionId);
            break;
          case 'session.delete':
            await handleSessionDelete(cmd.sessionId);
            break;
```

Finally, expose the new functions and `activeSessionId` through `_testing`. Find:

```ts
export const _testing = {
  handleStart,
  handleAbort,
  crashResume,
  setOrchestratorFactory(fn: ((opts: OrchestratorOpts) => Orchestrator) | null) {
    _makeOrchestrator = fn ?? ((opts) => new Orchestrator(opts));
  },
  state: () => ({ orchSet: _orch !== null, runId: _runId, starting: _starting, keepAlive: _keepAlive !== null, events: _events.length }),
  reset() {
    _orch = null;
    _abortController = null;
    _starting = false;
    _runId = 0;
    _events = [];
    stopKeepAlive();
  },
};
```

Replace with:

```ts
export const _testing = {
  handleStart,
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd extension && npx vitest run tests/unit/background_run_lifecycle.test.ts`
Expected: All tests PASS, including the new `session commands` block.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `cd extension && npm run typecheck && npx vitest run`
Expected: Both clean.

- [ ] **Step 7: Commit**

```bash
git add extension/src/shared/messages.ts extension/src/background/index.ts extension/tests/unit/background_run_lifecycle.test.ts
git commit -m "feat(background): wire session.new/list/select/delete panel commands"
```

---

### Task 5: Final verification

- [ ] **Step 1: Full suite**

Run: `cd extension && npm run typecheck && npx vitest run && npm run build`
Expected: typecheck clean, all tests pass (0 failures), build succeeds.

- [ ] **Step 2: Bench (if available)**

Run: `cd extension && npm run bench`
Expected: PASS if `ollama serve` is reachable from the test process. If not reachable, note that explicitly rather than silently skipping it — do not treat this as a blocking failure.

- [ ] **Step 3: Commit any final cleanup**

Only if Steps 1-2 surfaced something to fix. If everything is already green, there's nothing to commit here — proceed to final review.
