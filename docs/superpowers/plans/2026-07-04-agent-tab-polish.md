# Agent Tab Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two issues found via manual testing of the chat-sessions frontend: (1) a 101-second stall on non-actionable input like "Hi" caused by a planner→executor loop bug, and (2) a top-anchored composer instead of a ChatGPT-style bottom-anchored one.

**Architecture:** Part B (backend) ships first since it's the more serious correctness issue — a structural fix lets the Planner signal "no actionable goal" instead of inventing a fake step, short-circuiting straight to a `blocked` finish; a new heuristic layer intercepts obvious chitchat before the Orchestrator is even built, replying via one lightweight non-tool model call. Part A (frontend) restructures the Agent tab's JSX into three flex regions (fixed header, scrolling middle, fixed footer) — pure layout/CSS, no component logic changes.

**Tech Stack:** TypeScript, Vitest, React, Ollama HTTP API via `OllamaClient`.

**Reference spec:** `docs/superpowers/specs/2026-07-04-agent-tab-polish-design.md`

---

### Task 1: Planner "no actionable goal" signal + orchestrator short-circuit (Part B2)

**Files:**
- Modify: `extension/src/agent/prompts/index.ts`
- Modify: `extension/src/agent/roles/planner.ts`
- Modify: `extension/src/agent/orchestrator.ts`
- Test: `extension/tests/integration/orchestrator.test.ts`

- [ ] **Step 1: Write the failing test**

In `extension/tests/integration/orchestrator.test.ts`, add this test inside the existing `describe('orchestrator — session continuation', ...)` block is NOT the right home (that block is specifically about session carry-forward) — instead add a new `describe` block. Find the end of the file (the closing of the last `describe` block) and add, as a new top-level block:

```ts
describe('orchestrator — non-actionable input', () => {
  it('a planner that signals no actionable goal finishes immediately as blocked, without invoking the executor or evaluator', async () => {
    const roleCalls: Record<string, number> = {};
    const ollama = makeFakeOllama(
      { planner: [rawResponse({ content: JSON.stringify({ noGoal: true }) })] },
      { onChat: (_model, role) => { roleCalls[role] = (roleCalls[role] ?? 0) + 1; } },
    );
    const orch = new Orchestrator({ ollama, registry: buildRegistry(), settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const initial = await orch.start('Hi');
    const result = await orch.runUntilTerminal(initial);

    expect(result.phase).toBe('DONE');
    expect(result.verdict).toBe('blocked');
    expect(roleCalls.planner).toBe(1);
    expect(roleCalls.executor).toBeUndefined();
    expect(roleCalls.evaluator).toBeUndefined();
  });

  it('a normal actionable goal is unaffected — planner still returns real steps and the run proceeds', async () => {
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'search for the item', successCriteria: 'results shown' }] }) })],
      executor: [rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'done' } }] })],
      evaluator: [],
    });
    const orch = new Orchestrator({ ollama, registry: buildRegistry(), settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const initial = await orch.start('find a wireless mouse under $30');
    const result = await orch.runUntilTerminal(initial);

    expect(result.phase).toBe('DONE');
    expect(result.verdict).toBe('success');
  });
});
```

Check the top of `extension/tests/integration/orchestrator.test.ts` for its existing imports (`Orchestrator`, `buildRegistry`, `DEFAULT_SETTINGS`, `makeFakeOllama`, `rawResponse`, `describe`/`it`/`expect`) — all of these are already imported and used by other tests in this same file, so no new imports should be needed for this step.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npx vitest run tests/integration/orchestrator.test.ts -t "non-actionable input"`
Expected: FAIL — the first test fails because today's planner has no `noGoal` handling (`extractSteps` sees no `steps` array, treats `{"noGoal":true}` as malformed, retries once, gets the same `{}`-fallback response from the fake's empty retry queue, and throws `Planner returned no usable steps`). The second test should already PASS today (included as a baseline/regression guard, not expected to fail) — confirm it does.

- [ ] **Step 3: Add the `noGoal` instruction to the planner prompt**

In `extension/src/agent/prompts/index.ts`, find the `buildPlannerMessages` function's `system` template literal:

```ts
  const system = `You are the PLANNER in a goal-anchored browser agent.

Your job: Decompose the user's goal into a sequence of concrete, executable steps. Steps must be self-contained, observable, and have clear success criteria. Each step's successCriteria states what will be TRUE when the step is done (e.g. "the museum's facilities are listed on the page"), not the action performed.

Output: Respond ONLY with a JSON object of the form:
{"steps":[{"description":"...","successCriteria":"...","toolHint":"optional"}]}

CRITICAL — cover the WHOLE goal: every distinct part of the goal must map to at least one step. Do NOT collapse a multi-part goal into a single step. Examples:
```

Insert a new paragraph immediately after the `{"steps":[...]}` output-format line and before the `CRITICAL` paragraph:

```ts
  const system = `You are the PLANNER in a goal-anchored browser agent.

Your job: Decompose the user's goal into a sequence of concrete, executable steps. Steps must be self-contained, observable, and have clear success criteria. Each step's successCriteria states what will be TRUE when the step is done (e.g. "the museum's facilities are listed on the page"), not the action performed.

Output: Respond ONLY with a JSON object of the form:
{"steps":[{"description":"...","successCriteria":"...","toolHint":"optional"}]}

If GOAL is not an actionable task (a greeting like "hi", small talk, thanks, or text too vague to act on), do NOT invent a step that just asks for a goal — respond with EXACTLY {"noGoal":true} instead.

CRITICAL — cover the WHOLE goal: every distinct part of the goal must map to at least one step. Do NOT collapse a multi-part goal into a single step. Examples:
```

(Everything else in the function — the rest of `system`, and the entire `user` array below it — stays exactly as-is.)

- [ ] **Step 4: Give the planner a way to detect and return the `noGoal` signal**

In `extension/src/agent/roles/planner.ts`, find:

```ts
interface RawPlan {
  steps?: Array<{
    description?: string;
    successCriteria?: string;
    toolHint?: string;
  }>;
}

function extractSteps(raw: string): Array<{ description: string; successCriteria?: string; toolHint?: string }> {
  const parsed = parseJSONPermissive<RawPlan>(raw);
  return (parsed?.steps ?? [])
    .filter((s) => typeof s?.description === 'string')
    .map((s) => ({ description: s.description!, successCriteria: s.successCriteria, toolHint: s.toolHint }));
}
```

Replace with:

```ts
interface RawPlan {
  steps?: Array<{
    description?: string;
    successCriteria?: string;
    toolHint?: string;
  }>;
  /** The planner's explicit signal that GOAL isn't an actionable task — see the prompt in
   *  prompts/index.ts. Distinct from an empty/malformed steps array (which still retries). */
  noGoal?: boolean;
}

function parseRawPlan(raw: string): RawPlan | null {
  return parseJSONPermissive<RawPlan>(raw);
}

function extractSteps(parsed: RawPlan | null): Array<{ description: string; successCriteria?: string; toolHint?: string }> {
  return (parsed?.steps ?? [])
    .filter((s) => typeof s?.description === 'string')
    .map((s) => ({ description: s.description!, successCriteria: s.successCriteria, toolHint: s.toolHint }));
}
```

Now find `PlannerOutput`:

```ts
export interface PlannerOutput {
  plan: Plan;
  raw: string;
  promptEvalCount?: number;
  evalCount?: number;
  /** True iff the recipe-parity retry actually fired on this call (regardless of whether the
   *  richer plan was adopted). The caller (orchestrator) persists this onto the shared per-task
   *  hot state (`recipeRetryUsed`) so it is never fired again for the same task. */
  retryFired?: boolean;
}
```

Add a `noGoal` field:

```ts
export interface PlannerOutput {
  plan: Plan;
  raw: string;
  promptEvalCount?: number;
  evalCount?: number;
  /** True iff the recipe-parity retry actually fired on this call (regardless of whether the
   *  richer plan was adopted). The caller (orchestrator) persists this onto the shared per-task
   *  hot state (`recipeRetryUsed`) so it is never fired again for the same task. */
  retryFired?: boolean;
  /** True iff the planner signaled GOAL isn't actionable ({"noGoal":true}). `plan` is a throwaway
   *  empty plan in this case — the orchestrator must check this BEFORE using `plan` at all. */
  noGoal?: boolean;
}
```

Now find `runPlanner`'s body:

```ts
export async function runPlanner(input: PlannerInput): Promise<PlannerOutput> {
  const messages = buildPlannerMessages(input.ctx, input.replanContext, input.workflowRecipe);
  let resp = await input.ollama.chatOnce({
    model: input.model,
    messages,
    format: 'json',
    thinking: true,
    timeoutMs: input.timeoutMs ?? 300_000,
    signal: input.signal,
    numCtx: input.numCtx ?? NUM_CTX,
  });
  let raw = resp.message.content ?? '';
  let steps = extractSteps(raw);
  if (steps.length === 0) {
    // A small model occasionally emits a wrong-shaped or empty plan even under format:json
    // (e.g. {"plan":[...]} or {}). Retry once with an explicit shape reminder before aborting the
    // whole task — the executor already gets a retry; the planner shouldn't be the brittle link.
    const retryMessages = [
      ...messages,
      {
        role: 'user' as const,
        content:
          'That was not a usable plan. Respond with ONLY {"steps":[{"description":"...","successCriteria":"..."}]} containing at least one concrete step.',
      },
    ];
    resp = await input.ollama.chatOnce({
      model: input.model,
      messages: retryMessages,
      format: 'json',
      thinking: true,
      timeoutMs: input.timeoutMs ?? 300_000,
      signal: input.signal,
      numCtx: input.numCtx ?? NUM_CTX,
    });
    raw = resp.message.content ?? '';
    steps = extractSteps(raw);
  }
  if (steps.length === 0) {
    throw new Error(`Planner returned no usable steps. Raw: ${raw.slice(0, 200)}`);
  }
```

Replace with:

```ts
export async function runPlanner(input: PlannerInput): Promise<PlannerOutput> {
  const messages = buildPlannerMessages(input.ctx, input.replanContext, input.workflowRecipe);
  let resp = await input.ollama.chatOnce({
    model: input.model,
    messages,
    format: 'json',
    thinking: true,
    timeoutMs: input.timeoutMs ?? 300_000,
    signal: input.signal,
    numCtx: input.numCtx ?? NUM_CTX,
  });
  let raw = resp.message.content ?? '';
  let parsed = parseRawPlan(raw);
  if (parsed?.noGoal === true) {
    return { plan: newPlan([]), raw, noGoal: true, promptEvalCount: resp.promptEvalCount, evalCount: resp.evalCount };
  }
  let steps = extractSteps(parsed);
  if (steps.length === 0) {
    // A small model occasionally emits a wrong-shaped or empty plan even under format:json
    // (e.g. {"plan":[...]} or {}). Retry once with an explicit shape reminder before aborting the
    // whole task — the executor already gets a retry; the planner shouldn't be the brittle link.
    const retryMessages = [
      ...messages,
      {
        role: 'user' as const,
        content:
          'That was not a usable plan. Respond with ONLY {"steps":[{"description":"...","successCriteria":"..."}]} containing at least one concrete step.',
      },
    ];
    resp = await input.ollama.chatOnce({
      model: input.model,
      messages: retryMessages,
      format: 'json',
      thinking: true,
      timeoutMs: input.timeoutMs ?? 300_000,
      signal: input.signal,
      numCtx: input.numCtx ?? NUM_CTX,
    });
    raw = resp.message.content ?? '';
    parsed = parseRawPlan(raw);
    if (parsed?.noGoal === true) {
      return { plan: newPlan([]), raw, noGoal: true, promptEvalCount: resp.promptEvalCount, evalCount: resp.evalCount };
    }
    steps = extractSteps(parsed);
  }
  if (steps.length === 0) {
    throw new Error(`Planner returned no usable steps. Raw: ${raw.slice(0, 200)}`);
  }
```

(The rest of `runPlanner` — the recipe-collapse retry block and the final `return { plan, raw, promptEvalCount, evalCount, retryFired };` — stays exactly as-is. It's unreachable for a `noGoal` response since both `noGoal` checks above already `return` before this code runs.)

- [ ] **Step 5: Short-circuit the orchestrator when the planner signals `noGoal`**

In `extension/src/agent/orchestrator.ts`, add a new private field. Find:

```ts
  private sessionId: string | null = null;
  private priorSummary = '';
```

Add immediately after:

```ts
  private sessionId: string | null = null;
  private priorSummary = '';
  /** Set by plan() when the planner signals GOAL isn't actionable — checked once by
   *  runUntilTerminal right after planning, before entering the execute/evaluate loop. */
  private plannerNoGoal = false;
```

Reset it per-task in `start()`. Find:

```ts
    this.sourceUrls = new Set();
    this.steerNotes = [];
    this.runDirty = false;
```

Replace with:

```ts
    this.sourceUrls = new Set();
    this.steerNotes = [];
    this.runDirty = false;
    this.plannerNoGoal = false;
```

Now find the `plan()` method:

```ts
  private async plan(hot: AgentStateHot): Promise<AgentStateHot> {
    hot = await patchHot({ phase: 'PLANNING' });
    this.emit({ kind: 'role.start', ts: Date.now(), role: 'planner' });
    const t0 = performance.now();
    const out = await timed('planner', () =>
      runHeadChef(this.leadProvider, {
        ctx: this.commonCtx(hot),
        model: this.opts.settings.plannerModel,
        workflowRecipe: this.matchedWorkflow ? renderRecipe(this.matchedWorkflow) : undefined,
        recipeStepCount: this.matchedWorkflow?.steps.length,
        recipeRetryUsed: hot.recipeRetryUsed,
        signal: this.signal,
        numCtx: this.numCtx,
      }),
    );
    if (out.promptEvalCount && out.evalCount) {
      this.observeTokens(buildPlannerMessages(this.commonCtx(hot)), out.promptEvalCount);
    }
    hot = await this.applyPlan(hot, out.plan);
    // The recipe-parity retry (inside runPlanner) is bounded to once per TASK, not once per
    // runPlanner call — persist onto the shared hot state so a later outer replan() (which calls
    // runPlanner again from scratch) does not re-trigger it.
    if (out.retryFired) hot = await patchHot({ recipeRetryUsed: true });
    this.emit({ kind: 'planner.plan', ts: Date.now(), plan: out.plan });
    this.emit({ kind: 'role.end', ts: Date.now(), role: 'planner', ms: performance.now() - t0 });
    return hot;
  }
```

Replace with:

```ts
  private async plan(hot: AgentStateHot): Promise<AgentStateHot> {
    hot = await patchHot({ phase: 'PLANNING' });
    this.emit({ kind: 'role.start', ts: Date.now(), role: 'planner' });
    const t0 = performance.now();
    const out = await timed('planner', () =>
      runHeadChef(this.leadProvider, {
        ctx: this.commonCtx(hot),
        model: this.opts.settings.plannerModel,
        workflowRecipe: this.matchedWorkflow ? renderRecipe(this.matchedWorkflow) : undefined,
        recipeStepCount: this.matchedWorkflow?.steps.length,
        recipeRetryUsed: hot.recipeRetryUsed,
        signal: this.signal,
        numCtx: this.numCtx,
      }),
    );
    if (out.promptEvalCount && out.evalCount) {
      this.observeTokens(buildPlannerMessages(this.commonCtx(hot)), out.promptEvalCount);
    }
    this.plannerNoGoal = !!out.noGoal;
    if (out.noGoal) {
      // Nothing to apply/emit — there's no real plan. runUntilTerminal checks plannerNoGoal
      // immediately after this call and finishes as 'blocked' before the loop ever starts.
      this.emit({ kind: 'role.end', ts: Date.now(), role: 'planner', ms: performance.now() - t0 });
      return hot;
    }
    hot = await this.applyPlan(hot, out.plan);
    // The recipe-parity retry (inside runPlanner) is bounded to once per TASK, not once per
    // runPlanner call — persist onto the shared hot state so a later outer replan() (which calls
    // runPlanner again from scratch) does not re-trigger it.
    if (out.retryFired) hot = await patchHot({ recipeRetryUsed: true });
    this.emit({ kind: 'planner.plan', ts: Date.now(), plan: out.plan });
    this.emit({ kind: 'role.end', ts: Date.now(), role: 'planner', ms: performance.now() - t0 });
    return hot;
  }
```

Now find `runUntilTerminal`'s start:

```ts
  async runUntilTerminal(initial: AgentStateHot): Promise<RunResult> {
    let hot = initial;
    let turn = 0;
    const maxTurns = (this.opts.maxStepTurns ?? 8) * 12;

    // Fast path: a seeded plan (e.g. "Ask this page") skips the planner entirely — the slowest
    // call (up to 300s) — for goals where the steps are already known.
    hot =
      this.opts.seedPlan && this.opts.seedPlan.length
        ? await this.seedPlanInto(hot, this.opts.seedPlan)
        : await this.plan(hot);

    while (turn < maxTurns) {
```

Replace with:

```ts
  async runUntilTerminal(initial: AgentStateHot): Promise<RunResult> {
    let hot = initial;
    let turn = 0;
    const maxTurns = (this.opts.maxStepTurns ?? 8) * 12;

    // Fast path: a seeded plan (e.g. "Ask this page") skips the planner entirely — the slowest
    // call (up to 300s) — for goals where the steps are already known.
    hot =
      this.opts.seedPlan && this.opts.seedPlan.length
        ? await this.seedPlanInto(hot, this.opts.seedPlan)
        : await this.plan(hot);

    // The planner determined GOAL isn't actionable — finish immediately rather than dispatching a
    // fake step to the Executor (which has no tool that can satisfy "please provide a goal" and
    // would just loop). Never true on the seedPlan path (askPage always has a real forced step).
    if (this.plannerNoGoal) {
      return this.finishOk(hot, 'blocked', 'I need a clearer goal to work with — could you tell me what you\'d like me to do?');
    }

    while (turn < maxTurns) {
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd extension && npx vitest run tests/integration/orchestrator.test.ts`
Expected: PASS — both new tests, and every other test in this file (this fix must not change behavior for any existing scripted scenario, since `noGoal` is a new, opt-in field no existing test's fake responses set).

- [ ] **Step 7: Run the full suite + typecheck**

Run: `cd extension && npm run typecheck && npx vitest run`
Expected: no errors, all tests pass.

- [ ] **Step 8: Commit**

```bash
cd extension && git add src/agent/prompts/index.ts src/agent/roles/planner.ts src/agent/orchestrator.ts tests/integration/orchestrator.test.ts
git commit -m "fix(orchestrator): let the planner signal no actionable goal instead of looping the executor on a fake step"
```

---

### Task 2: Instant reply for obvious chitchat (Part B1)

**Files:**
- Create: `extension/src/background/quick_chat.ts`
- Modify: `extension/src/background/index.ts`
- Test: `extension/tests/unit/quick_chat.test.ts` (new)
- Test: `extension/tests/unit/background_run_lifecycle.test.ts`

- [ ] **Step 1: Write the failing tests for `quick_chat.ts`**

Create `extension/tests/unit/quick_chat.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isTrivialChitchat, quickChatReply, QUICK_CHAT_FALLBACK } from '@/background/quick_chat';
import { makeFakeOllama, rawResponse } from '../helpers';

describe('isTrivialChitchat', () => {
  it('matches common greetings and chitchat, case-insensitively and with trailing punctuation', () => {
    const matches = ['hi', 'Hi', 'HELLO', 'hey', 'hey!', 'hello there.', 'good morning', 'test', 'thanks', 'thank you', 'ok', 'okay?'];
    for (const m of matches) {
      expect(isTrivialChitchat(m)).toBe(true);
    }
  });

  it('does not match real goals, even short ones', () => {
    const realGoals = ['find a wireless mouse under $30', 'buy milk', 'check gmail', 'what is the price of a Raspberry Pi 5?'];
    for (const g of realGoals) {
      expect(isTrivialChitchat(g)).toBe(false);
    }
  });

  it('trims surrounding whitespace before matching', () => {
    expect(isTrivialChitchat('   hi   ')).toBe(true);
  });
});

describe('quickChatReply', () => {
  it('returns the trimmed reply text from a normal chat completion', async () => {
    const ollama = makeFakeOllama({ unknown: [rawResponse({ content: '  Hi there! What can I help you with?  ' })] });
    const reply = await quickChatReply(ollama, 'gemma4:e4b', 'hi');
    expect(reply).toBe('Hi there! What can I help you with?');
  });

  it('throws when the model returns an empty reply, so the caller can fall back', async () => {
    const ollama = makeFakeOllama({ unknown: [rawResponse({ content: '   ' })] });
    await expect(quickChatReply(ollama, 'gemma4:e4b', 'hi')).rejects.toThrow();
  });
});

describe('QUICK_CHAT_FALLBACK', () => {
  it('is a non-empty static string', () => {
    expect(QUICK_CHAT_FALLBACK.length).toBeGreaterThan(0);
  });
});
```

Note: `quickChatReply`'s system prompt won't contain "You are the PLANNER/EXECUTOR/EVALUATOR/COMPACTOR", so `makeFakeOllama`'s role-detection falls through to `'unknown'` — that's why the queue key above is `unknown`, not one of the four named roles.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npx vitest run tests/unit/quick_chat.test.ts`
Expected: FAIL — `Cannot find module '@/background/quick_chat'`.

- [ ] **Step 3: Create `quick_chat.ts`**

Create `extension/src/background/quick_chat.ts`:

```ts
// Fast path for chitchat that isn't a real task — skips the Planner/Executor/Evaluator loop
// entirely (see docs/superpowers/specs/2026-07-04-agent-tab-polish-design.md, Part B1).
import type { OllamaClient } from './ollama';

// Deliberately narrow and explicit — NOT a "short message" heuristic, which would misclassify
// real short goals like "buy milk" or "check gmail".
const CHITCHAT_PHRASES = new Set([
  'hi', 'hello', 'hey', 'hiya', 'yo', 'hello there', 'hey there',
  'good morning', 'good afternoon', 'good evening',
  'test', 'thanks', 'thank you', 'ok', 'okay',
]);

export function isTrivialChitchat(goal: string): boolean {
  const normalized = goal.trim().toLowerCase().replace(/[.!?]+$/, '');
  return CHITCHAT_PHRASES.has(normalized);
}

export const QUICK_CHAT_FALLBACK =
  'Hi! Tell me what you\'d like me to do — e.g. "find the cheapest flight to NYC".';

/** One lightweight, non-tool-calling chat completion — NOT the Planner/Executor/Evaluator
 *  prompts, which are shaped for goal-decomposition and tool-calling and would be the wrong
 *  tool for a friendly reply. Short timeout: if this isn't fast, the caller should fall back
 *  to QUICK_CHAT_FALLBACK rather than let a "quick" aside take as long as a real task. */
export async function quickChatReply(ollama: OllamaClient, model: string, goal: string): Promise<string> {
  const resp = await ollama.chatOnce({
    model,
    messages: [
      {
        role: 'system',
        content:
          'You are a friendly on-device browser assistant. The user just sent a casual greeting or small talk, not a task. Reply warmly in ONE short sentence, then invite them to give you a real task with a concrete example (e.g. "find the cheapest flight to NYC" or "summarize this page"). Do not use tools or ask clarifying questions about a task — there is no task yet.',
      },
      { role: 'user', content: goal },
    ],
    timeoutMs: 15_000,
  });
  const text = resp.message.content?.trim();
  if (!text) throw new Error('Quick chat: empty reply');
  return text;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && npx vitest run tests/unit/quick_chat.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the `background/index.ts` wiring**

In `extension/tests/unit/background_run_lifecycle.test.ts`, add this test inside the existing `describe('session commands', ...)` block, after the last test and before its closing `});`:

```ts
  it('a chitchat message never creates a session or touches the orchestrator — it gets a quick reply instead', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, opts?: RequestInit) => {
      const body = JSON.parse((opts?.body as string) ?? '{}');
      // /api/chat (quickChatReply) — anything else in this test hitting fetch is unexpected.
      if (body.messages) {
        return { ok: true, status: 200, json: async () => ({ message: { role: 'assistant', content: 'Hi there!' }, done: true }) } as Response;
      }
      throw new Error(`unexpected fetch in this test: ${JSON.stringify(body)}`);
    }) as typeof globalThis.fetch;
    let orchestratorFactoryCalled = false;
    bg.setOrchestratorFactory(() => {
      orchestratorFactoryCalled = true;
      throw new Error('orchestrator should never be constructed for chitchat');
    });

    await bg.handleQuickChat('hi');

    expect(orchestratorFactoryCalled).toBe(false);
    expect(bg.state().activeSessionId).toBeNull();
    expect((await listSessions()).length).toBe(0);

    globalThis.fetch = origFetch;
    bg.setOrchestratorFactory(null);
  });
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd extension && npx vitest run tests/unit/background_run_lifecycle.test.ts -t "chitchat message"`
Expected: FAIL — `bg.handleQuickChat is not a function` (nothing wires or exposes it yet).

- [ ] **Step 7: Wire the chitchat check into `background/index.ts`, before session auto-create**

Add the import. Find:

```ts
import { OllamaClient } from './ollama';
```

Replace with:

```ts
import { OllamaClient } from './ollama';
import { isTrivialChitchat, quickChatReply, QUICK_CHAT_FALLBACK } from './quick_chat';
```

Add the new `handleQuickChat` function. Find `pushSessions` (an existing small function):

```ts
async function pushSessions() {
  broadcast({ type: 'sessions', sessions: await listSessions(), activeSessionId: _activeSessionId });
}
```

Add immediately after it:

```ts
async function pushSessions() {
  broadcast({ type: 'sessions', sessions: await listSessions(), activeSessionId: _activeSessionId });
}

/** Fast path for chitchat (see quick_chat.ts) — no session, no Orchestrator, one lightweight
 *  model call. Falls back to a static reply if the call fails (Ollama down, timeout, etc.) rather
 *  than surfacing an error for what's supposed to be the most forgiving path in the app. */
async function handleQuickChat(goal: string) {
  const settings = await loadSettings();
  const ollama = new OllamaClient(settings.ollamaBaseUrl);
  let summary: string;
  try {
    summary = await quickChatReply(ollama, settings.executorModel, goal);
  } catch {
    summary = QUICK_CHAT_FALLBACK;
  }
  broadcast({ type: 'append', event: { kind: 'finish', ts: Date.now(), verdict: 'chat', summary } });
}
```

Now wire it into the `agent.start` case. Find:

```ts
          case 'agent.start':
            // Detached on purpose (NOT awaited). Chrome force-kills a single
            // onMessage handler at the 5-minute event-execution cap; a long
            // multi-step run (12b at ~14 t/s) blows past that. Returning from the
            // listener immediately ends the event, escaping the 5-min window — the
            // orchestrator then runs as a top-level task sustained by the 20s
            // keepalive, with no cumulative SW lifetime limit. handleStart has its
            // own try/catch/finally, so detaching loses no error handling.
            // autoSession=true: only agent.start auto-creates a session (see handleStart).
            void handleStart(cmd.goal, undefined, true);
            break;
```

Replace with:

```ts
          case 'agent.start':
            if (isTrivialChitchat(cmd.goal)) {
              // No session, no Orchestrator — this is chitchat, not a chat turn.
              void handleQuickChat(cmd.goal);
              break;
            }
            // Detached on purpose (NOT awaited). Chrome force-kills a single
            // onMessage handler at the 5-minute event-execution cap; a long
            // multi-step run (12b at ~14 t/s) blows past that. Returning from the
            // listener immediately ends the event, escaping the 5-min window — the
            // orchestrator then runs as a top-level task sustained by the 20s
            // keepalive, with no cumulative SW lifetime limit. handleStart has its
            // own try/catch/finally, so detaching loses no error handling.
            // autoSession=true: only agent.start auto-creates a session (see handleStart).
            void handleStart(cmd.goal, undefined, true);
            break;
```

Finally, expose `handleQuickChat` for direct testing. Find the `_testing` export block:

```ts
export const _testing = {
  handleStart,
  handleAbort,
  handleSessionNew,
  handleSessionSelect,
  handleSessionDelete,
  crashResume,
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
  crashResume,
```

- [ ] **Step 8: Run the full suite + typecheck**

Run: `cd extension && npm run typecheck && npx vitest run`
Expected: no errors, all tests pass, including the new quick-chat tests and every pre-existing test (this fast path is opt-in — only fires for the exact chitchat list — so no existing test's goal strings should match it; double-check none of the existing tests in `background_run_lifecycle.test.ts`/`orchestrator.test.ts` happen to use a goal string like `'a goal'` that's ALSO on the `CHITCHAT_PHRASES` list — `'a goal'` is not on the list, so this should be safe, but confirm the full suite is green as the real proof).

- [ ] **Step 9: Commit**

```bash
cd extension && git add src/background/quick_chat.ts src/background/index.ts tests/unit/quick_chat.test.ts tests/unit/background_run_lifecycle.test.ts
git commit -m "feat(background): instant reply for obvious chitchat, bypassing the orchestrator entirely"
```

---

### Task 3: Bottom-anchored chat layout (Part A)

**Files:**
- Modify: `extension/src/sidepanel/App.tsx`
- Modify: `extension/src/sidepanel/styles.css`

- [ ] **Step 1: Update the top-level layout CSS to fill the viewport**

In `extension/src/sidepanel/styles.css`, find:

```css
html, body, #root { margin: 0; padding: 0; min-height: 100%; background: var(--bg); color: var(--fg); }
```

Replace with:

```css
html, body, #root { margin: 0; padding: 0; height: 100%; overflow: hidden; background: var(--bg); color: var(--fg); }
```

Find:

```css
.app { display: flex; flex-direction: column; background: var(--bg); }
```

Replace with:

```css
.app { display: flex; flex-direction: column; background: var(--bg); height: 100%; }
```

Find:

```css
.content { padding: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-3); }
```

Replace with:

```css
.content { flex: 1; min-height: 0; padding: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-3); overflow-y: auto; }
```

- [ ] **Step 2: Add the 3-region Agent tab layout CSS**

In `extension/src/sidepanel/styles.css`, immediately after the `.content` rule you just modified, add:

```css
.agent-tab { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: var(--sp-3); }
.agent-tab-header { flex-shrink: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
.agent-tab-scroll { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: var(--sp-3); }
.agent-tab-composer { flex-shrink: 0; }
```

- [ ] **Step 3: Restructure the Agent tab's JSX into the 3 regions**

In `extension/src/sidepanel/App.tsx`, add a ref for the scrolling region. Find:

```ts
  const clientRef = useRef<PortClient | null>(null);
```

Add immediately after:

```ts
  const clientRef = useRef<PortClient | null>(null);
  const agentScrollRef = useRef<HTMLDivElement>(null);
```

Add the auto-scroll effect. Find the existing reset-on-session-switch effect's closing:

```ts
    if (prevSessionId.current !== activeSessionId) {
      prevSessionId.current = activeSessionId;
      setEvents([]);
      setNotice(null);
      setRunStartedAt(null);
    }
  }, [activeSessionId]);
```

Add immediately after it:

```ts
    if (prevSessionId.current !== activeSessionId) {
      prevSessionId.current = activeSessionId;
      setEvents([]);
      setNotice(null);
      setRunStartedAt(null);
    }
  }, [activeSessionId]);

  // Auto-scroll the transcript/activity pane to the latest content — matches ordinary chat-app
  // behavior so the user isn't stuck manually scrolling down while the composer stays pinned at
  // the bottom.
  const pastTurnsCountForScroll = (sessions.find((s) => s.id === activeSessionId)?.turns.length ?? 0);
  useEffect(() => {
    const el = agentScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [events, pastTurnsCountForScroll, running]);
```

(`pastTurnsCountForScroll` is computed here, ahead of the `pastTurns`/`finish` derivation further down in the component, specifically so this effect has a stable, cheap primitive number to depend on rather than a freshly-created array/object reference — `pastTurns` itself is a new array literal every render, which would make the effect's dependency comparison always see a "change" and defeat the point of a dependency array.)

Now restructure the Agent tab's render block. Find:

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
              running={running}
              goal={goal}
              onGoalChange={setGoal}
              onRun={handleStart}
              applyUrl={applyUrl}
              onApplyUrlChange={setApplyUrl}
              onApply={handleApply}
              onAskPage={handleAskPage}
              onSteer={handleSteer}
              onStop={handleAbort}
              showExamples={events.length === 0 && status.phase === 'IDLE'}
            />

            {notice && !ollamaDown && <Alert kind={notice.kind}>{notice.msg}</Alert>}

            <Transcript turns={pastTurns} />

            {running && <RunState phase={status.phase} plan={status.plan} elapsedMs={elapsedMs} />}

            {!running && finish && (
              <ResultCard
                verdict={finish.verdict}
                summary={finish.summary}
                steps={stepCount}
                elapsedMs={elapsedMs}
                replans={status.replanCount}
                sources={finish.sources}
              />
            )}

            {showEmpty ? (
              <div className="empty">
                <div className="empty-mark">
                  <Icon name="spark" size={22} />
                </div>
                <div className="empty-title">Ready when you are</div>
                <div className="empty-text">
                  State a goal and I'll handle the browsing — planning, reading pages, and reporting the
                  answer. Everything runs on your machine.
                </div>
              </div>
            ) : (
              <Timeline events={events} open={activityOpen} onToggle={() => setActivityOpen((o) => !o)} />
            )}
          </>
        )}
```

Replace with:

```tsx
        {tab === 'agent' && (
          <div className="agent-tab">
            <div className="agent-tab-header">
              {ollamaDown && <ConnectionCard baseUrl={settings.ollamaBaseUrl} onRetry={handleRetry} />}

              <SessionSwitcher
                sessions={sessions}
                activeSessionId={activeSessionId}
                onNew={() => send({ type: 'session.new' })}
                onSelect={(id) => send({ type: 'session.select', sessionId: id })}
                onDelete={(id) => send({ type: 'session.delete', sessionId: id })}
              />
            </div>

            <div className="agent-tab-scroll" ref={agentScrollRef}>
              {notice && !ollamaDown && <Alert kind={notice.kind}>{notice.msg}</Alert>}

              <Transcript turns={pastTurns} />

              {running && <RunState phase={status.phase} plan={status.plan} elapsedMs={elapsedMs} />}

              {!running && finish && (
                <ResultCard
                  verdict={finish.verdict}
                  summary={finish.summary}
                  steps={stepCount}
                  elapsedMs={elapsedMs}
                  replans={status.replanCount}
                  sources={finish.sources}
                />
              )}

              {showEmpty ? (
                <div className="empty">
                  <div className="empty-mark">
                    <Icon name="spark" size={22} />
                  </div>
                  <div className="empty-title">Ready when you are</div>
                  <div className="empty-text">
                    State a goal and I'll handle the browsing — planning, reading pages, and reporting the
                    answer. Everything runs on your machine.
                  </div>
                </div>
              ) : (
                <Timeline events={events} open={activityOpen} onToggle={() => setActivityOpen((o) => !o)} />
              )}
            </div>

            <div className="agent-tab-composer">
              <Composer
                running={running}
                goal={goal}
                onGoalChange={setGoal}
                onRun={handleStart}
                applyUrl={applyUrl}
                onApplyUrlChange={setApplyUrl}
                onApply={handleApply}
                onAskPage={handleAskPage}
                onSteer={handleSteer}
                onStop={handleAbort}
                showExamples={events.length === 0 && status.phase === 'IDLE'}
              />
            </div>
          </div>
        )}
```

- [ ] **Step 4: Typecheck**

Run: `cd extension && npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Run the full test suite**

Run: `cd extension && npx vitest run`
Expected: PASS — all tests green (this is a pure JSX/CSS restructuring; no component props or logic changed, so no existing test should be affected).

- [ ] **Step 6: Manual verification in the browser**

Run: `cd extension && npm run build`

If you have a way to load the unpacked extension (`extension/dist`) in a real Chrome with `ollama serve` running (see the repo's own `python scripts/browser_smoke.py` or manual "Load unpacked" instructions in the README) — verify:
1. The composer sits at the bottom of the panel; `SessionSwitcher` sits at the top, both stay visible without scrolling.
2. Start a goal that produces enough activity to overflow the panel height. Confirm only the middle region scrolls — header and composer stay fixed.
3. Confirm the middle region auto-scrolls to the bottom as new activity streams in, without needing to manually scroll.
4. Switch tabs to Settings/Recipes/Metrics — confirm they still scroll normally (unaffected by this change).

If a live browser isn't available in your environment, report the build succeeded and that the manual walkthrough itself could not be performed, rather than fabricating a walkthrough you didn't do — this matches how this exact limitation was handled in the immediately-preceding chat-sessions-frontend cycle (a chrome-devtools MCP server with no way to load an unpacked extension into an already-running profile).

- [ ] **Step 7: Commit**

```bash
cd extension && git add src/sidepanel/App.tsx src/sidepanel/styles.css
git commit -m "feat(sidepanel): bottom-anchored chat layout — fixed header/composer, scrolling transcript"
```

---

### Task 4: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `cd extension && npx vitest run`
Expected: all tests pass, 0 failures (allow the 1 pre-existing skipped test).

- [ ] **Step 2: Typecheck**

Run: `cd extension && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Build**

Run: `cd extension && npm run build`
Expected: succeeds, `extension/dist` produced.

- [ ] **Step 4: Manually re-verify the original bug report's exact scenario, if a browser is available**

Type "Hi" into the composer and hit Run. Expected: a reply appears within a few seconds (not ~101 seconds), no session is created for it (the switcher shows no new entry), and the reply reads as a natural, friendly redirect toward giving a real task. If a browser isn't available in this environment, this step is covered by Task 1's and Task 2's automated tests instead — note that explicitly rather than fabricating a manual result.

- [ ] **Step 5: Commit (only if any of the above required a fix)**

```bash
cd extension && git add -A
git commit -m "fix: address final verification findings"
```
