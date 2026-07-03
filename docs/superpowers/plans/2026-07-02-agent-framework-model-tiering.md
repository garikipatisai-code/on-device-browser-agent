# Agent Framework + Model Tiering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Formalize the planner/executor/evaluator/compactor roles as a head-chef/sous-chef/helper seat contract with a pluggable `ModelProvider`, then let the head-chef and sous-chef seats optionally run on a frontier Anthropic model while the helper seat always stays local — with local-only behavior unchanged when hybrid mode is off.

**Architecture:** Stage A (Tasks 1–7) introduces `agent/framework/{provider,head_chef,sous_chef,helper}.ts` as thin wrappers around the existing `roles/*.ts` functions, swaps `Orchestrator`'s direct `runPlanner`/`runExecutor`/`runEvaluator`/`runCompactor` calls for the wrappers, and relocates `verifyFinish`/`gateFinishSummary` into `sous_chef.ts` as pure functions — all while staying 100% local, verified by the full suite staying green. Stage B (Tasks 8–15) adds `frontierProvider()` (raw `fetch` against the Anthropic Messages API — matching this repo's existing `OllamaClient` pattern of no SDK dependency), `withFallback()`, Settings wiring, and the Settings UI toggle.

**Tech Stack:** TypeScript, Vitest, existing `@/background/ollama` client shape, Anthropic Messages API via raw `fetch` (no new npm dependency).

---

## Deviations from the spec, stated up front

Read against the actual current code (not assumed), three things changed from `docs/superpowers/specs/2026-07-02-agent-framework-model-tiering-design.md`:

1. **No new `Directive`/`Ticket`/`Report`/`Verdict` message types.** `PlannerInput`/`PlannerOutput`, `ExecutorInput`/`ExecutorOutput`, `EvaluatorInput`/`Verdict`, `CompactorInput`/`CompactorOutput` already exist and are already well-typed — inventing a parallel type hierarchy would just wrap them for no behavioral benefit. The seats are the new thing; the existing Input/Output types remain the contracts.
2. **`frontierProvider` uses raw `fetch`, not `@anthropic-ai/sdk`.** This repo's `OllamaClient` deliberately has "no SDK dependency" (its own header comment). Adding the Anthropic SDK would be the first new runtime dependency in a deliberately dependency-light project, and the SDK's browser-safety flag (`dangerouslyAllowBrowser`) is designed around a threat model (page JS, not a privileged extension service worker) that doesn't map cleanly here. Raw `fetch` against `POST https://api.anthropic.com/v1/messages` matches the existing pattern exactly and sidesteps the question.
3. **No new `provider.fallback` timeline event kind.** The existing `{kind:'log', level:'warn', message}` event already renders visibly in the Timeline UI with zero new UI code. A new `TimelineEvent` variant would need changes in `shared/messages.ts` and the sidepanel's event-classification code for no user-visible difference.

None of these change the spec's actual commitments (head-chef/sous-chef/helper seats, provider-per-seat, grounding moves to sous-chef, existing role names/files unchanged, local-only default is structural not promised).

---

## Stage A — Provider abstraction + framework wrappers (behavior-preserving)

### Task 1: `ModelProvider` interface + `localProvider`

**Files:**
- Create: `extension/src/agent/framework/provider.ts`
- Test: `extension/tests/unit/framework_provider.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { localProvider } from '@/agent/framework/provider';
import { makeFakeOllama } from '../helpers';

describe('localProvider', () => {
  it('delegates chatOnce to the wrapped OllamaClient', async () => {
    const fake = makeFakeOllama({ executor: [] });
    const provider = localProvider(fake);
    const res = await provider.chatOnce({ model: 'x', messages: [{ role: 'system', content: 'You are the EXECUTOR' }] });
    expect(res.rawText).toBe('{}'); // makeFakeOllama's default when a queue is empty
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run tests/unit/framework_provider.test.ts`
Expected: FAIL — `Cannot find module '@/agent/framework/provider'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// extension/src/agent/framework/provider.ts
// The seam every seat (head chef, sous chef, helper) calls through — lets a
// seat's model backend be swapped without the seat's own code knowing.
import type { ChatOptions, ChatResponse, OllamaClient } from '@/background/ollama';

export interface ModelProvider {
  chatOnce(opts: ChatOptions): Promise<ChatResponse>;
}

// OllamaClient already structurally satisfies ModelProvider (it has chatOnce
// with this exact shape) — this is an identity function, kept as a named,
// self-documenting call site rather than passing the client bare.
export function localProvider(ollama: OllamaClient): ModelProvider {
  return ollama;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run tests/unit/framework_provider.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add extension/src/agent/framework/provider.ts extension/tests/unit/framework_provider.test.ts
git commit -m "feat(framework): add ModelProvider interface and localProvider adapter"
```

---

### Task 2: Widen the four role Input types to accept `ModelProvider`

**Files:**
- Modify: `extension/src/agent/roles/planner.ts:2,12`
- Modify: `extension/src/agent/roles/executor.ts:3,13`
- Modify: `extension/src/agent/roles/evaluator.ts:2,11`
- Modify: `extension/src/agent/roles/compactor.ts:2,12`

No new test — this is a type-only widening (`OllamaClient` → `ModelProvider`, and every real `OllamaClient` value already satisfies the narrower type), verified by `npm run typecheck` staying clean and the full existing role/prompt test suite staying green.

- [ ] **Step 1: Widen `planner.ts`**

Change:
```typescript
import type { OllamaClient } from '@/background/ollama';
```
to:
```typescript
import type { ModelProvider } from '../framework/provider';
```
and change the `ollama: OllamaClient;` field in `PlannerInput` to `ollama: ModelProvider;`.

- [ ] **Step 2: Widen `executor.ts`**

Change:
```typescript
import type { ChatMessage, OllamaClient, ToolDef } from '@/background/ollama';
```
to:
```typescript
import type { ChatMessage, ToolDef } from '@/background/ollama';
import type { ModelProvider } from '../framework/provider';
```
and change `ollama: OllamaClient;` in `ExecutorInput` to `ollama: ModelProvider;`.

- [ ] **Step 3: Widen `evaluator.ts`**

Change:
```typescript
import type { OllamaClient } from '@/background/ollama';
```
to:
```typescript
import type { ModelProvider } from '../framework/provider';
```
and change `ollama: OllamaClient;` in `EvaluatorInput` to `ollama: ModelProvider;`.

- [ ] **Step 4: Widen `compactor.ts`**

Change:
```typescript
import type { OllamaClient } from '@/background/ollama';
```
to:
```typescript
import type { ModelProvider } from '../framework/provider';
```
and change `ollama: OllamaClient;` in `CompactorInput` to `ollama: ModelProvider;`.

- [ ] **Step 5: Verify nothing broke**

Run: `cd extension && npm run typecheck && npx vitest run`
Expected: PASS — every existing call site passes a real `OllamaClient`, which already satisfies `ModelProvider`, so no caller changes.

- [ ] **Step 6: Commit**

```bash
git add extension/src/agent/roles/planner.ts extension/src/agent/roles/executor.ts extension/src/agent/roles/evaluator.ts extension/src/agent/roles/compactor.ts
git commit -m "refactor(roles): widen ollama param type from OllamaClient to ModelProvider"
```

---

### Task 3: `runHeadChef` wrapper

**Files:**
- Create: `extension/src/agent/framework/head_chef.ts`
- Test: `extension/tests/unit/framework_head_chef.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { runHeadChef } from '@/agent/framework/head_chef';
import { localProvider } from '@/agent/framework/provider';
import { makeFakeOllama, rawResponse } from '../helpers';

describe('runHeadChef', () => {
  it('delegates to runPlanner with the given provider', async () => {
    const fake = makeFakeOllama({
      planner: [rawResponse({ content: '{"steps":[{"description":"do it","successCriteria":"done"}]}' })],
    });
    const out = await runHeadChef(localProvider(fake), {
      ctx: { goal: 'test', toolCatalog: '' } as never,
      model: 'x',
    });
    expect(out.plan.steps).toHaveLength(1);
    expect(out.plan.steps[0].description).toBe('do it');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run tests/unit/framework_head_chef.test.ts`
Expected: FAIL — `Cannot find module '@/agent/framework/head_chef'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// extension/src/agent/framework/head_chef.ts
// The head chef seat: decides the plan. Wraps roles/planner.ts unchanged —
// message-building, retry, and recipe-parity logic all stay exactly as they
// are; only the model backend becomes swappable.
import { runPlanner, type PlannerInput, type PlannerOutput } from '../roles/planner';
import type { ModelProvider } from './provider';

export async function runHeadChef(
  provider: ModelProvider,
  input: Omit<PlannerInput, 'ollama'>,
): Promise<PlannerOutput> {
  return runPlanner({ ...input, ollama: provider });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run tests/unit/framework_head_chef.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add extension/src/agent/framework/head_chef.ts extension/tests/unit/framework_head_chef.test.ts
git commit -m "feat(framework): add runHeadChef seat wrapper around runPlanner"
```

---

### Task 4: `runSousChef` wrapper + relocate grounding verification

**Files:**
- Create: `extension/src/agent/framework/sous_chef.ts`
- Test: `extension/tests/unit/framework_sous_chef.test.ts`

This is the one seat with real logic beyond a pass-through: `verifyFinish`/`gateFinishSummary` move here from `orchestrator.ts` as exported pure functions (same logic, `this.observedText`/`this.facts` become explicit params).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { runSousChef, verifyFinish, gateFinishSummary } from '@/agent/framework/sous_chef';
import { localProvider } from '@/agent/framework/provider';
import { makeFakeOllama, rawResponse } from '../helpers';

describe('runSousChef', () => {
  it('delegates to runEvaluator with the given provider', async () => {
    const fake = makeFakeOllama({
      evaluator: [rawResponse({ content: '{"verdict":"PASS","reason":"ok"}' })],
    });
    const ev = await runSousChef(localProvider(fake), {
      ctx: { goal: 'test', toolCatalog: '' } as never,
      model: 'x',
      lastExecutorResult: 'result',
      step: { id: '1', description: 'd', successCriteria: 's', status: 'active' },
    });
    expect(ev.verdict).toBe('PASS');
  });
});

describe('verifyFinish', () => {
  it('accepts a summary whose numbers were actually observed', () => {
    const v = verifyFinish('The price is $24.99', 'the page shows $24.99 in stock', []);
    expect(v.ok).toBe(true);
  });

  it('rejects a summary asserting a number never observed', () => {
    const v = verifyFinish('The price is $999.99', 'the page shows $24.99 in stock', []);
    expect(v.ok).toBe(false);
  });
});

describe('gateFinishSummary', () => {
  it('downgrades an ungrounded success to partial with an unverified note', () => {
    const g = gateFinishSummary('success', 'The price is $999.99', 'the page shows $24.99', []);
    expect(g.verdict).toBe('partial');
    expect(g.summary).toContain('[unverified against page');
  });

  it('passes through blocked/failed verdicts unchanged', () => {
    const g = gateFinishSummary('blocked', 'could not access the page', '', []);
    expect(g).toEqual({ verdict: 'blocked', summary: 'could not access the page' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run tests/unit/framework_sous_chef.test.ts`
Expected: FAIL — `Cannot find module '@/agent/framework/sous_chef'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// extension/src/agent/framework/sous_chef.ts
// The sous chef seat: checks the work. Wraps roles/evaluator.ts unchanged,
// and owns grounding verification (moved here from orchestrator.ts — "does
// this actually hold up before it goes out" is exactly the sous chef's job).
import { runEvaluator, type EvaluatorInput, type Verdict } from '../roles/evaluator';
import type { ModelProvider } from './provider';
import { ungroundedNumbers } from '../verify/grounding';
import { groundingCorpus, type Fact } from '../facts';

export async function runSousChef(
  provider: ModelProvider,
  input: Omit<EvaluatorInput, 'ollama'>,
): Promise<Verdict> {
  return runEvaluator({ ...input, ollama: provider });
}

/** Verify a success answer is grounded in what was actually read.
 *  Deterministic number check only: an e4b LLM verify was tried but false-rejected
 *  correct/honest answers in the benchmark (correct 80%→67%), so it was dropped —
 *  see docs/superpowers/specs/2026-06-18-theme-a-page-grounded-verification-design.md. */
export function verifyFinish(
  summary: string,
  observedText: string,
  facts: Fact[],
): { ok: boolean; reason: string } {
  if (!summary || !summary.trim()) {
    return { ok: false, reason: 'no answer text provided' };
  }
  const ungrounded = ungroundedNumbers(summary, groundingCorpus(observedText, facts));
  if (ungrounded.length) {
    return { ok: false, reason: `value(s) not found on any page read: ${ungrounded.join(', ')}` };
  }
  return { ok: true, reason: '' };
}

/** Gate any data-bearing finish (executor OR evaluator) through the deterministic grounding
 *  check. Both roles are the same small-model class and can assert a number that's on no page
 *  read. A 'success' carrying an ungrounded (or empty) answer is downgraded to 'partial'; a
 *  'partial' keeps its verdict but gets the unverified note appended (it's already a concession).
 *  'blocked'/'failed' are honest non-answers with no fabrication risk and pass through unchanged. */
export function gateFinishSummary(
  verdict: string,
  summary: string,
  observedText: string,
  facts: Fact[],
): { verdict: string; summary: string } {
  if (verdict !== 'success' && verdict !== 'partial') return { verdict, summary };
  const v = verifyFinish(summary, observedText, facts);
  if (v.ok) return { verdict, summary };
  return { verdict: 'partial', summary: `${summary}\n\n[unverified against page: ${v.reason}]` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run tests/unit/framework_sous_chef.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add extension/src/agent/framework/sous_chef.ts extension/tests/unit/framework_sous_chef.test.ts
git commit -m "feat(framework): add runSousChef seat wrapper; relocate grounding verification here"
```

---

### Task 5: `runHelper` + `runHelperCompaction` wrappers

**Files:**
- Create: `extension/src/agent/framework/helper.ts`
- Test: `extension/tests/unit/framework_helper.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { runHelper, runHelperCompaction } from '@/agent/framework/helper';
import { localProvider } from '@/agent/framework/provider';
import { ToolRegistry } from '@/agent/tools/registry';
import { makeFakeOllama, rawResponse } from '../helpers';

describe('runHelper', () => {
  it('delegates to runExecutor with the given provider', async () => {
    const fake = makeFakeOllama({
      executor: [rawResponse({ toolCalls: [{ name: 'echo', args: { message: 'hi' } }] })],
    });
    const registry = new ToolRegistry();
    const out = await runHelper(localProvider(fake), {
      ctx: { goal: 'test', toolCatalog: '' } as never,
      model: 'x',
      registry,
      toolCtx: {} as never,
    });
    expect(out.tool).toBe('echo');
  });
});

describe('runHelperCompaction', () => {
  it('delegates to runCompactor with the given provider', async () => {
    const fake = makeFakeOllama({
      compactor: [rawResponse({ content: '{"summary":"short"}' })],
    });
    const out = await runHelperCompaction(localProvider(fake), {
      goal: 'test',
      toolCatalog: '',
      scratchpad: 'a very long scratchpad'.repeat(100),
      model: 'x',
    });
    expect(out.summary).toBe('short');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run tests/unit/framework_helper.test.ts`
Expected: FAIL — `Cannot find module '@/agent/framework/helper'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// extension/src/agent/framework/helper.ts
// The helper seat: does the tool-calling grunt work. Wraps roles/executor.ts
// and roles/compactor.ts unchanged — always local-provider-backed in this
// phase (see docs/superpowers/specs/2026-07-02-agent-framework-model-tiering-design.md,
// "Explicitly NOT doing" — concurrent helpers are a follow-on spec).
import { runExecutor, type ExecutorInput, type ExecutorOutput } from '../roles/executor';
import { runCompactor, type CompactorInput, type CompactorOutput } from '../roles/compactor';
import type { ModelProvider } from './provider';

export async function runHelper(
  provider: ModelProvider,
  input: Omit<ExecutorInput, 'ollama'>,
): Promise<ExecutorOutput> {
  return runExecutor({ ...input, ollama: provider });
}

export async function runHelperCompaction(
  provider: ModelProvider,
  input: Omit<CompactorInput, 'ollama'>,
): Promise<CompactorOutput> {
  return runCompactor({ ...input, ollama: provider });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run tests/unit/framework_helper.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add extension/src/agent/framework/helper.ts extension/tests/unit/framework_helper.test.ts
git commit -m "feat(framework): add runHelper and runHelperCompaction seat wrappers"
```

---

### Task 6: Wire the seats into `Orchestrator`

**Files:**
- Modify: `extension/src/agent/orchestrator.ts`

No new test file — verified by the existing integration tests (`tests/integration/{executor,orchestrator,scripted_e2e}.test.ts`) staying green, since behavior must be byte-identical.

- [ ] **Step 1: Update imports**

In `orchestrator.ts`, replace:
```typescript
import { runPlanner } from './roles/planner';
import { runExecutor } from './roles/executor';
import { runEvaluator, type Verdict } from './roles/evaluator';
import { addGroundedFact, groundingCorpus, renderFacts, type Fact } from './facts';
import { runCompactor } from './roles/compactor';
```
with:
```typescript
import type { Verdict } from './roles/evaluator';
import { addGroundedFact, renderFacts, type Fact } from './facts';
import { runHeadChef } from './framework/head_chef';
import { runSousChef, verifyFinish, gateFinishSummary } from './framework/sous_chef';
import { runHelper, runHelperCompaction } from './framework/helper';
import { localProvider, type ModelProvider } from './framework/provider';
```
(`groundingCorpus` is no longer used directly in `orchestrator.ts` — it's internal to `sous_chef.ts` now. `ungroundedNumbers` from `./verify/grounding` is still used directly at the mid-plan-prose-answer check around line 237 — leave that import as-is.)

- [ ] **Step 2: Add provider fields, set them in the constructor**

Add two private fields near the other private fields (after `private runDirty = false;`):
```typescript
  private leadProvider: ModelProvider;
  private helperProvider: ModelProvider;
```
Change the constructor from:
```typescript
  constructor(private opts: OrchestratorOpts) {
    this.signal = opts.signal ?? new AbortController().signal;
  }
```
to:
```typescript
  constructor(private opts: OrchestratorOpts) {
    this.signal = opts.signal ?? new AbortController().signal;
    this.leadProvider = localProvider(opts.ollama);
    this.helperProvider = localProvider(opts.ollama);
  }
```
(Stage B changes only the `leadProvider` line.)

- [ ] **Step 3: Swap the four role call sites**

In `plan()` (and identically in `replan()`), the call currently reads:
```typescript
    const out = await timed('planner', () =>
      runPlanner({
        ctx: this.commonCtx(hot),
        model: this.opts.settings.plannerModel,
        ollama: this.opts.ollama,
        workflowRecipe: this.matchedWorkflow ? renderRecipe(this.matchedWorkflow) : undefined,
        recipeStepCount: this.matchedWorkflow?.steps.length,
        recipeRetryUsed: hot.recipeRetryUsed,
        signal: this.signal,
        numCtx: this.numCtx,
      }),
    );
```
Change only the function name and drop the `ollama:` line — every other field is untouched:
```typescript
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
```
`replan()`'s call is the same shape plus a `replanContext: reason,` field — apply the identical `runPlanner`→`runHeadChef(this.leadProvider, ...)` rename and `ollama:`-line removal there, leaving `replanContext` and every other field untouched.

In `executeOne()`, the call currently reads:
```typescript
    const out = await timed('executor', () =>
      runExecutor({
        ctx,
        model: this.opts.settings.executorModel,
        ollama: this.opts.ollama,
        registry: this.opts.registry,
        toolCtx,
        toolFilter,
        signal: this.signal,
        numCtx: this.numCtx,
      }),
    );
```
Change only the function name and drop the `ollama:` line:
```typescript
    const out = await timed('executor', () =>
      runHelper(this.helperProvider, {
        ctx,
        model: this.opts.settings.executorModel,
        registry: this.opts.registry,
        toolCtx,
        toolFilter,
        signal: this.signal,
        numCtx: this.numCtx,
      }),
    );
```

In `evaluate()`, the call currently reads:
```typescript
    const ev = await timed('evaluator', () =>
      runEvaluator({
        ctx: this.commonCtx(hot, scratch),
        model: this.opts.settings.evaluatorModel,
        ollama: this.opts.ollama,
        lastExecutorResult: lastResult,
        step,
        signal: this.signal,
        numCtx: this.numCtx,
      }),
    );
```
Change only the function name and drop the `ollama:` line:
```typescript
    const ev = await timed('evaluator', () =>
      runSousChef(this.leadProvider, {
        ctx: this.commonCtx(hot, scratch),
        model: this.opts.settings.evaluatorModel,
        lastExecutorResult: lastResult,
        step,
        signal: this.signal,
        numCtx: this.numCtx,
      }),
    );
```

In `compact()`, the call currently reads:
```typescript
    const out = await timed('compactor', () =>
      runCompactor({
        goal: hotState.goal,
        toolCatalog: this.opts.registry.describe(),
        scratchpad: scratch,
        model: this.opts.settings.compactorModel,
        ollama: this.opts.ollama,
        signal: this.signal,
        numCtx: this.numCtx,
      }),
    );
```
Change only the function name and drop the `ollama:` line:
```typescript
    const out = await timed('compactor', () =>
      runHelperCompaction(this.helperProvider, {
        goal: hotState.goal,
        toolCatalog: this.opts.registry.describe(),
        scratchpad: scratch,
        model: this.opts.settings.compactorModel,
        signal: this.signal,
        numCtx: this.numCtx,
      }),
    );
```

- [ ] **Step 4: Remove the two relocated private methods**

Delete the `private verifyFinish(summary: string): ...` and `private gateFinishSummary(verdict: string, summary: string): ...` method bodies entirely (now imported from `./framework/sous_chef`).

- [ ] **Step 5: Update the five call sites that used the removed methods**

- In `runUntilTerminal()`: `const v = this.verifyFinish(fin.summary);` → `const v = verifyFinish(fin.summary, this.observedText, this.facts);`
- In `finalizeFinish()`: `const g = this.gateFinishSummary(verdict, summary);` → `const g = gateFinishSummary(verdict, summary, this.observedText, this.facts);`
- In `reconcileMissingFromCorpus()`: `const g = this.gateFinishSummary('success', corpusAnswer);` → `const g = gateFinishSummary('success', corpusAnswer, this.observedText, this.facts);`
- In `giveUp()`: `const g = this.gateFinishSummary('partial', answer);` → `const g = gateFinishSummary('partial', answer, this.observedText, this.facts);`
- In `preferSalvageOnDenial()`: `const g = this.gateFinishSummary('partial', salvaged);` → `const g = gateFinishSummary('partial', salvaged, this.observedText, this.facts);`

- [ ] **Step 6: Verify byte-identical behavior**

Run: `cd extension && npm run typecheck && npx vitest run`
Expected: PASS, same pass count as before this task (61 test files / 512 tests per the earlier baseline — confirm the count matches, not just "green").

- [ ] **Step 7: Commit**

```bash
git add extension/src/agent/orchestrator.ts
git commit -m "refactor(orchestrator): call head-chef/sous-chef/helper seats instead of roles directly"
```

---

### Task 7: Stage A checkpoint — full verification

**Files:** none (verification only)

- [ ] **Step 1: Full suite + typecheck + build**

Run: `cd extension && npm run typecheck && npx vitest run && npm run build`
Expected: all green, `dist/` builds cleanly. This is the safety checkpoint the spec called for — Stage B is additive from here, not a rewrite of proven-safe code.

- [ ] **Step 2: Commit the checkpoint (no-op if Task 6 already committed everything)**

```bash
git status
```
Expected: clean tree. Nothing to commit — this step exists to make the checkpoint explicit before starting Stage B.

---

## Stage B — Frontier provider + hybrid mode

### Task 8: Settings additions

**Files:**
- Modify: `extension/src/shared/messages.ts:30-72`

- [ ] **Step 1: Add the fields to the `Settings` interface**

After `numCtx?: number;` (before the closing brace of `Settings`), add:
```typescript
  /** Master toggle: when true, the head-chef and sous-chef seats (planner,
   *  evaluator) may run on the configured frontier model instead of local
   *  Ollama. The helper seat (executor, compactor) always stays local. */
  hybridMode?: boolean;
  frontier?: {
    provider: 'anthropic';
    apiKey: string;
    model: string;
  };
```

- [ ] **Step 2: Add the default**

In `DEFAULT_SETTINGS`, after `numCtx: 32_768,`, add:
```typescript
  hybridMode: false,
```
(`frontier` is intentionally omitted from the default — `undefined` until the user configures it.)

- [ ] **Step 3: Verify**

Run: `cd extension && npm run typecheck`
Expected: PASS (additive optional fields, no existing code touches them yet).

- [ ] **Step 4: Commit**

```bash
git add extension/src/shared/messages.ts
git commit -m "feat(settings): add hybridMode and frontier config fields"
```

---

### Task 9: `frontierProvider` + `withFallback`

**Files:**
- Modify: `extension/src/agent/framework/provider.ts`
- Test: `extension/tests/unit/framework_provider.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `extension/tests/unit/framework_provider.test.ts`:

```typescript
import { frontierProvider, withFallback, resolveLeadProvider } from '@/agent/framework/provider';
import { DEFAULT_SETTINGS } from '@/shared/messages';

describe('frontierProvider', () => {
  it('translates a system+user request and returns the text response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: '{"steps":[]}' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = frontierProvider({ provider: 'anthropic', apiKey: 'sk-test', model: 'claude-opus-4-8' });
    const res = await provider.chatOnce({
      model: 'claude-opus-4-8',
      messages: [
        { role: 'system', content: 'You are the PLANNER' },
        { role: 'user', content: 'plan this' },
      ],
      format: 'json',
    });

    expect(res.rawText).toBe('{"steps":[]}');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('sk-test');
    const body = JSON.parse(init.body);
    expect(body.system).toBe('You are the PLANNER');
    expect(body.messages).toEqual([{ role: 'user', content: 'plan this' }]);

    vi.unstubAllGlobals();
  });

  it('throws on a policy refusal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [], stop_reason: 'refusal', stop_details: { category: 'cyber' } }),
    }));
    const provider = frontierProvider({ provider: 'anthropic', apiKey: 'sk-test', model: 'claude-opus-4-8' });
    await expect(provider.chatOnce({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/declined/);
    vi.unstubAllGlobals();
  });

  it('throws a status-bearing error on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' }));
    const provider = frontierProvider({ provider: 'anthropic', apiKey: 'sk-test', model: 'claude-opus-4-8' });
    await expect(provider.chatOnce({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ status: 500 });
    vi.unstubAllGlobals();
  });
});

describe('withFallback', () => {
  it('passes through a successful primary call untouched', async () => {
    const primary = { chatOnce: vi.fn().mockResolvedValue({ message: { role: 'assistant', content: 'ok' }, done: true, toolCalls: [], rawText: 'ok' }) };
    const fallback = { chatOnce: vi.fn() };
    const provider = withFallback(primary, fallback);
    const res = await provider.chatOnce({ model: 'x', messages: [] });
    expect(res.rawText).toBe('ok');
    expect(fallback.chatOnce).not.toHaveBeenCalled();
  });

  it('retries once on a 5xx, then falls back on continued failure', async () => {
    const err500 = Object.assign(new Error('server error'), { status: 500 });
    const primary = { chatOnce: vi.fn().mockRejectedValue(err500) };
    const fallback = { chatOnce: vi.fn().mockResolvedValue({ message: { role: 'assistant', content: 'local' }, done: true, toolCalls: [], rawText: 'local' }) };
    const onFallback = vi.fn();
    const provider = withFallback(primary, fallback, onFallback);
    const res = await provider.chatOnce({ model: 'x', messages: [] });
    expect(primary.chatOnce).toHaveBeenCalledTimes(2); // one retry
    expect(res.rawText).toBe('local');
    expect(onFallback).toHaveBeenCalledWith('server error');
  });

  it('falls back immediately on a non-retryable error, no retry', async () => {
    const err401 = Object.assign(new Error('bad key'), { status: 401 });
    const primary = { chatOnce: vi.fn().mockRejectedValue(err401) };
    const fallback = { chatOnce: vi.fn().mockResolvedValue({ message: { role: 'assistant', content: 'local' }, done: true, toolCalls: [], rawText: 'local' }) };
    const provider = withFallback(primary, fallback);
    await provider.chatOnce({ model: 'x', messages: [] });
    expect(primary.chatOnce).toHaveBeenCalledTimes(1); // no retry
  });
});

describe('resolveLeadProvider', () => {
  it('resolves to local when hybridMode is off', () => {
    const fake = makeFakeOllama({});
    const p = resolveLeadProvider({ ...DEFAULT_SETTINGS, hybridMode: false }, fake);
    expect(p).toBe(fake); // localProvider is an identity function
  });

  it('resolves to local when hybridMode is on but no frontier config is present', () => {
    const fake = makeFakeOllama({});
    const p = resolveLeadProvider({ ...DEFAULT_SETTINGS, hybridMode: true }, fake);
    expect(p).toBe(fake);
  });

  it('resolves to a fallback-wrapped frontier provider when fully configured', () => {
    const fake = makeFakeOllama({});
    const p = resolveLeadProvider(
      { ...DEFAULT_SETTINGS, hybridMode: true, frontier: { provider: 'anthropic', apiKey: 'sk-test', model: 'claude-opus-4-8' } },
      fake,
    );
    expect(p).not.toBe(fake);
  });
});
```

No new import needed for `vi` — `vite.config.ts`'s test block sets `globals: true`, which exposes `vi` (and `describe`/`it`/`expect`) globally, same as every other test file in this repo.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extension && npx vitest run tests/unit/framework_provider.test.ts`
Expected: FAIL — `frontierProvider`, `withFallback`, `resolveLeadProvider` are not exported yet.

- [ ] **Step 3: Write the implementation**

Append to `extension/src/agent/framework/provider.ts`:

```typescript
import type { Settings } from '@/shared/messages';
import { composeSignal } from '@/background/signal';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Reuse Settings['frontier'] rather than defining a second, structurally-identical
// interface — provider.ts already imports Settings for resolveLeadProvider below.
export type FrontierConfig = NonNullable<Settings['frontier']>;

/** Raw fetch against the Anthropic Messages API — no SDK dependency, matching
 *  OllamaClient's own pattern. Only ever called for the head-chef/sous-chef
 *  seats (planner, evaluator), which never pass `tools` or multi-turn
 *  tool_result history — so this only needs to translate a single system
 *  message + a run of user/assistant messages. If a future frontier-eligible
 *  seat needs tool-calling, this needs the full tool_use/tool_result mapping,
 *  deliberately not built here. */
export function frontierProvider(cfg: FrontierConfig): ModelProvider {
  return {
    async chatOnce(opts: ChatOptions): Promise<ChatResponse> {
      const { system, messages } = splitSystem(opts.messages);
      const body: Record<string, unknown> = {
        model: cfg.model,
        max_tokens: 4096,
        messages,
        thinking: { type: 'adaptive' },
      };
      if (system) body.system = system;

      const { signal, cleanup } = composeSignal(opts.timeoutMs ?? 120_000, opts.signal);
      try {
        const res = await fetch(ANTHROPIC_API_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': cfg.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify(body),
          signal,
        });
        if (!res.ok) throw frontierHttpError(res.status, await safeText(res));
        return normalizeAnthropicResponse(await res.json());
      } finally {
        cleanup();
      }
    },
  };
}

function splitSystem(messages: ChatOptions['messages']): { system?: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> } {
  const sys = messages.find((m) => m.role === 'system');
  const rest = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  return { system: sys?.content, messages: rest };
}

function normalizeAnthropicResponse(json: Record<string, unknown>): ChatResponse {
  if (json.stop_reason === 'refusal') {
    const category = (json.stop_details as { category?: string } | undefined)?.category ?? 'refusal';
    throw new Error(`Frontier model declined the request (${category})`);
  }
  const blocks = (json.content as Array<{ type: string; text?: string }> | undefined) ?? [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  const usage = json.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  return {
    message: { role: 'assistant', content: text },
    done: true,
    promptEvalCount: usage?.input_tokens,
    evalCount: usage?.output_tokens,
    toolCalls: [],
    rawText: text,
  };
}

function frontierHttpError(status: number, body: string): Error & { status: number } {
  const err = new Error(`Anthropic HTTP ${status}: ${body.slice(0, 256)}`) as Error & { status: number };
  err.status = status;
  return err;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/** Composes at the resolution layer so runHeadChef/runSousChef stay unaware
 *  fallback exists — they just call provider.chatOnce(). One retry on a
 *  retryable error (5xx — matches OllamaClient.withRetry); no retry on a
 *  non-retryable error (4xx, or a thrown refusal) since retrying won't help.
 *  Either way, falls back to `fallback` and reports why via onFallback. */
export function withFallback(
  primary: ModelProvider,
  fallback: ModelProvider,
  onFallback?: (reason: string) => void,
): ModelProvider {
  return {
    async chatOnce(opts: ChatOptions): Promise<ChatResponse> {
      try {
        return await primary.chatOnce(opts);
      } catch (err) {
        if (isRetryableFrontierError(err)) {
          try {
            return await primary.chatOnce(opts);
          } catch (retryErr) {
            onFallback?.(describeFallbackReason(retryErr));
            return fallback.chatOnce(opts);
          }
        }
        onFallback?.(describeFallbackReason(err));
        return fallback.chatOnce(opts);
      }
    },
  };
}

function isRetryableFrontierError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const status = (err as { status?: number }).status;
  return typeof status === 'number' && status >= 500 && status < 600;
}

function describeFallbackReason(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown frontier error';
}

/** Resolved once per run for the head-chef and sous-chef seats — they always
 *  resolve identically, since hybridMode is one master toggle, not two
 *  independent ones. Falls out to local whenever hybrid mode is off or no
 *  frontier config is present: this IS the "local-only is the unchanged
 *  default" guarantee, not a promise layered on top of it. */
export function resolveLeadProvider(
  settings: Settings,
  ollama: OllamaClient,
  onFallback?: (reason: string) => void,
): ModelProvider {
  if (!settings.hybridMode || !settings.frontier?.apiKey) return localProvider(ollama);
  return withFallback(frontierProvider(settings.frontier), localProvider(ollama), onFallback);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && npx vitest run tests/unit/framework_provider.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `cd extension && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add extension/src/agent/framework/provider.ts extension/tests/unit/framework_provider.test.ts
git commit -m "feat(framework): add frontierProvider, withFallback, and resolveLeadProvider"
```

---

### Task 10: Wire `resolveLeadProvider` into `Orchestrator`

**Files:**
- Modify: `extension/src/agent/orchestrator.ts`

- [ ] **Step 1: Update the import**

Change:
```typescript
import { localProvider, type ModelProvider } from './framework/provider';
```
to:
```typescript
import { localProvider, resolveLeadProvider, type ModelProvider } from './framework/provider';
```

- [ ] **Step 2: Update the constructor**

Change:
```typescript
    this.leadProvider = localProvider(opts.ollama);
    this.helperProvider = localProvider(opts.ollama);
```
to:
```typescript
    this.leadProvider = resolveLeadProvider(opts.settings, opts.ollama, (reason) =>
      this.emit({
        kind: 'log',
        ts: Date.now(),
        level: 'warn',
        message: `Frontier call failed, using local model instead: ${reason}`,
      }),
    );
    this.helperProvider = localProvider(opts.ollama);
```

- [ ] **Step 3: Regression check — this is the one that matters most**

Run: `cd extension && npx vitest run`
Expected: PASS, same count as the Task 7 checkpoint. With `hybridMode` defaulting to `false`, `resolveLeadProvider` returns `localProvider(opts.ollama)` — identical to what Stage A had inline. No test should need updating for this reason alone.

- [ ] **Step 4: Typecheck + build**

Run: `cd extension && npm run typecheck && npm run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add extension/src/agent/orchestrator.ts
git commit -m "feat(orchestrator): resolve the lead-seat provider from settings (hybrid mode)"
```

---

### Task 11: Regression test — `hybridMode: false` is byte-identical to pre-change baseline

**Files:**
- Modify: `extension/tests/integration/scripted_e2e.test.ts` (add one test; do not change the existing three)

The file already drives the real `Orchestrator` + real tools + a fake model through the `sale-price` fixture (lines 28–55). Reuse that exact fixture and assertions verbatim, with `hybridMode: false` set explicitly in settings — proving the new provider-resolution code path in the constructor produces the identical outcome, not just "still passes."

- [ ] **Step 1: Write the test**

Add inside the existing `describe('scripted-browser E2E ...')` block, after the third `it(...)`:

```typescript
  it('sale-price with hybridMode explicitly false matches the pre-tiering baseline', async () => {
    const t = task('sale-price');
    const state = new ScriptedBrowser(t);
    const registry = buildScriptedRegistry(state);
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'open the Studio Wireless Headphones product and report its current price', successCriteria: 'current price reported' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'tab.open', args: { url: 'https://shop.example/' } }] }),
        rawResponse({ toolCalls: [{ name: 'tab.click', args: { tabId: 101, elementIndex: 1 } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'The current price is £59.99 (down from £79.99).' } }] }),
      ],
      evaluator: [],
    });
    const orch = new Orchestrator({
      ollama,
      registry,
      settings: { ...DEFAULT_SETTINGS, hybridMode: false },
      emit: () => undefined,
    });
    const result = await orch.runUntilTerminal(await orch.start(t.goal));

    expect(result.phase).toBe('DONE');
    expect(result.verdict).toBe('success');

    const run: BenchRun = {
      phase: result.phase, verdict: result.verdict, summary: result.summary,
      observedText: `${t.goal}\n${state.observedText()}`, turns: result.turns, replans: result.replans,
    };
    const score = scoreRun(t.expect, run);
    expect(score, score.reasons.join('; ')).toMatchObject({ completed: true, correct: true, grounded: true });
  });
```

- [ ] **Step 2: Run it**

Run: `cd extension && npx vitest run tests/integration/scripted_e2e.test.ts`
Expected: PASS, 4 tests now (was 3).

- [ ] **Step 3: Commit**

```bash
git add extension/tests/integration/scripted_e2e.test.ts
git commit -m "test: pin hybridMode:false to the pre-tiering baseline behavior"
```

---

### Task 12: Settings UI — hybrid mode toggle

**Files:**
- Modify: `extension/src/sidepanel/components/SettingsPanel.tsx`

- [ ] **Step 1: Add a local update helper for the nested `frontier` object**

Near the existing `update` function (around line 47), add:
```typescript
  const updateFrontier = (patch: Partial<NonNullable<Settings['frontier']>>) =>
    setLocal((s) => ({
      ...s,
      frontier: {
        provider: 'anthropic',
        apiKey: '',
        model: '',
        ...s.frontier,
        ...patch,
      },
    }));
```

- [ ] **Step 2: Add the card**

After the "Domain access" card's closing `</div>` (before the `<div className="save-bar">`), add:

```tsx
      {/* Frontier model (optional) */}
      <div className="card setting-group">
        <div className="card-title">
          <Icon name="spark" size={13} /> Frontier model (optional)
        </div>
        <div className="field-hint">
          Let the planner and evaluator use a frontier model instead of the local one. Everything
          else (reading pages, clicking, typing) always stays local. Off by default.
        </div>
        <label className="field-hint" style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 8 }}>
          <input
            type="checkbox"
            checked={!!local.hybridMode}
            onChange={(e) => update('hybridMode', e.target.checked)}
          />
          <span>
            <strong>Use a frontier model for planning and evaluation (hybrid mode)</strong>. Calls a
            paid API repeatedly during a run (roughly every 3rd turn) — this app doesn't track or cap
            that spend.
          </span>
        </label>
        {local.hybridMode && (
          <>
            <div className="field">
              <span className="field-label">Model</span>
              <input
                placeholder="claude-opus-4-8"
                value={local.frontier?.model ?? ''}
                onChange={(e) => updateFrontier({ model: e.target.value })}
              />
            </div>
            <div className="field">
              <span className="field-label">API key</span>
              <input
                type="password"
                placeholder="sk-ant-..."
                value={local.frontier?.apiKey ?? ''}
                onChange={(e) => updateFrontier({ apiKey: e.target.value })}
              />
            </div>
          </>
        )}
      </div>
```

- [ ] **Step 3: Manual check**

Run: `cd extension && npm run dev`, load the unpacked extension, open Settings, confirm the new card renders, the checkbox reveals the model/key fields, and unrelated settings still save correctly.

- [ ] **Step 4: Typecheck + component test**

Run: `cd extension && npm run typecheck && npx vitest run tests/unit/components_render.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add extension/src/sidepanel/components/SettingsPanel.tsx
git commit -m "feat(settings-ui): add hybrid mode toggle and frontier model/key fields"
```

---

### Task 13: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full suite, typecheck, build**

Run: `cd extension && npm run typecheck && npx vitest run && npm run build`
Expected: all green.

- [ ] **Step 2: Bench, if Ollama is running locally**

Run: `cd extension && npm run bench`
Expected: `completed`/`correct`/`grounded` rates at or above whatever they were before this change (the grounding logic itself didn't change behavior, only which file it lives in — this is confirming that, not expecting a different number). Skip this step if `ollama serve` isn't available in the environment running the plan; note that explicitly rather than silently skipping.

- [ ] **Step 3: Commit any final fixes**

If Steps 1–2 found nothing, there's nothing to commit — the plan is done.
