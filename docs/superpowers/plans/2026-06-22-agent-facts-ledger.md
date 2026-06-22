# Grounded Facts Ledger — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the on-device agent a small, grounded, always-in-context "facts ledger" so multi-step tasks stop losing facts gathered on early turns, and make the context window a reversible setting.

**Architecture:** Activate the dormant `findings` rail. The evaluator emits an optional `fact` per evaluated step; the orchestrator grounds it (numbers must appear in what was read), keeps a bounded/deduped in-memory `Fact[]`, and renders it into the existing `FINDINGS:` prompt slot on every executor + evaluator turn. Finish-grounding then checks numbers against observed-text **∪** the ledger, and a mid-plan prose answer is grounded before it can advance the plan. Phase 2 makes `num_ctx` a reversible setting (default 32768) with budgets/caps derived from it.

**Tech Stack:** TypeScript, Chrome MV3, local Ollama (gemma4:e4b), Vitest. Build/test via `cd /Users/saikrishna.2177481/Documents/Spike/browser-agent-blueprint/extension && "$HOME/.nvm/versions/node/v24.16.0/bin/node" "$HOME/.nvm/versions/node/v24.16.0/bin/npx" <vitest|tsc|vite>`.

**Honest scope note:** The spec listed "rehydrate `this.facts` on resume." Dropped: `start()` mints a fresh `taskId` and there is no seamless mid-loop resume (SW-kill aborts the run). Facts are still persisted via `addFinding` for durability/audit, but rehydration would test a non-existent path. Everything else in the spec is covered below.

**Conventions:** Branch per task off `main` (`git switch -c feat/<task>`), TDD (failing test → minimal code → green → commit), ff-merge to `main` when green, prune. All paths relative to `extension/`.

---

## File Structure

**Phase 1 — Ledger (memory + context + harness). Ships independently; additive.**
- `src/agent/facts.ts` *(new)* — pure ledger helpers: `Fact`, `addGroundedFact`, `renderFacts`, `groundingCorpus`. No I/O. The testable heart.
- `src/agent/roles/evaluator.ts` — extract a pure `parseVerdict(raw)`; add `fact` to `Verdict`.
- `src/agent/prompts/index.ts` — add `fact` to the evaluator's JSON shape + one rule.
- `src/agent/orchestrator.ts` — own `this.facts`; capture after evaluate; render into `commonCtx.findingsBlock`; ground finish against the ledger; gate mid-plan prose.
- Tests: `tests/unit/facts.test.ts`, evaluator parse test, `tests/integration/orchestrator.test.ts`.

**Phase 2 — Configurable window. Ships independently; defaults to today's 32K.**
- `src/agent/budget.ts` — `clampNumCtx`, `budgetsFor`, `capsFor`; `checkBudget` takes `numCtx`.
- `src/shared/messages.ts` — `Settings.numCtx`.
- `src/agent/roles/{planner,executor,evaluator,compactor}.ts` — thread `numCtx` (mirror the existing `model` field).
- `src/agent/orchestrator.ts` — resolve `numCtx` from settings; pass to roles + `checkBudget`; derive caps.
- `src/sidepanel/components/SettingsPanel.tsx` — a num_ctx field with the staged-verification warning.

---

## Task 1: Evaluator emits an optional, salvage-safe `fact`

**Files:**
- Modify: `src/agent/roles/evaluator.ts` (extract `parseVerdict`, add `fact` to `Verdict`)
- Modify: `src/agent/prompts/index.ts` (`buildEvaluatorMessages` system prompt)
- Test: `tests/unit/evaluator_parse.test.ts`

- [ ] **Step 1: Write the failing test**

> Note: if a brand-new test file fails to resolve the `@/` alias (a hiccup seen before), colocate these cases in an existing `tests/unit/*.test.ts` that already imports from `@/agent`.

```ts
// tests/unit/evaluator_parse.test.ts
import { describe, expect, it } from 'vitest';
import { parseVerdict } from '@/agent/roles/evaluator';

describe('parseVerdict', () => {
  it('extracts a fact from clean JSON', () => {
    const v = parseVerdict('{"verdict":"PASS","reason":"ok","shouldReplan":false,"finishVerdict":null,"finishSummary":null,"fact":"Austin population: 961,855"}');
    expect(v.verdict).toBe('PASS');
    expect(v.fact).toBe('Austin population: 961,855');
  });
  it('returns fact=null when absent or blank', () => {
    expect(parseVerdict('{"verdict":"PASS"}').fact).toBeNull();
    expect(parseVerdict('{"verdict":"PASS","fact":"   "}').fact).toBeNull();
  });
  it('still salvages PASS/FAIL from a truncated body (fact stays null)', () => {
    const v = parseVerdict('{"verdict":"PASS","reason":"the value 961,8');
    expect(v.verdict).toBe('PASS');
    expect(v.fact).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `"$HOME/.nvm/versions/node/v24.16.0/bin/node" "$HOME/.nvm/versions/node/v24.16.0/bin/npx" vitest run tests/unit/evaluator_parse.test.ts`
Expected: FAIL — `parseVerdict` is not exported.

- [ ] **Step 3: Add `fact` to `Verdict` and extract `parseVerdict`**

In `src/agent/roles/evaluator.ts`, add to the `Verdict` interface (after `finishSummary`):

```ts
  /** One short grounded datum this step established (copied from the page), or null. */
  fact: string | null;
```

Replace the parsing block inside `runEvaluator` (from `const parsed =` through the `return {…}`) with a call to a new exported pure function, and define it:

```ts
export function parseVerdict(raw: string): Verdict {
  const parsed = parseJSONPermissive<Partial<Verdict>>(raw);
  // Small models emit odd casing/whitespace even under format:json — normalize so a
  // clearly-passing verdict isn't silently defaulted to FAIL.
  let v = String(parsed?.verdict ?? '').trim().toUpperCase();
  if (v !== 'PASS' && v !== 'FAIL') {
    // Structured parse failed (response cut off mid-JSON). Salvage just the PASS/FAIL token.
    // We do NOT salvage finishVerdict or fact — those on a truncated body would be unsafe.
    const m = raw.match(/"?verdict"?\s*[:=]\s*"?\s*(PASS|FAIL)/i);
    if (m) v = m[1].toUpperCase();
  }
  const verdict: 'PASS' | 'FAIL' = v === 'PASS' ? 'PASS' : 'FAIL';
  const fv = String(parsed?.finishVerdict ?? '').trim().toLowerCase();
  const fact = typeof parsed?.fact === 'string' && parsed.fact.trim() ? parsed.fact.trim() : null;
  return {
    verdict,
    reason: typeof parsed?.reason === 'string' ? parsed.reason : 'No evaluator reason provided.',
    shouldReplan: !!parsed?.shouldReplan,
    finishVerdict: fv === 'success' ? 'success' : fv === 'blocked' ? 'blocked' : fv === 'failed' ? 'failed' : null,
    finishSummary: typeof parsed?.finishSummary === 'string' ? parsed.finishSummary : null,
    fact,
    raw,
  };
}
```

And in `runEvaluator`, after `const raw = resp.message.content ?? '';`, replace the rest with:

```ts
  return parseVerdict(raw);
```

- [ ] **Step 4: Run it — expect PASS**

Run: `"$HOME/.nvm/versions/node/v24.16.0/bin/node" "$HOME/.nvm/versions/node/v24.16.0/bin/npx" vitest run tests/unit/evaluator_parse.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Teach the evaluator to emit `fact`**

In `src/agent/prompts/index.ts`, `buildEvaluatorMessages`, change the JSON shape line to include `fact`:

```ts
{"verdict":"PASS"|"FAIL","reason":"specific evidence","shouldReplan":true|false,"finishVerdict":"success"|"blocked"|"failed"|null,"finishSummary":string|null,"fact":string|null}
```

Add this bullet to the system rules (after the `finishVerdict` bullet):

```ts
- fact: if this step established a concrete datum the GOAL needs (a value, price, count, name), set it to ONE short line copied verbatim from the page — e.g. "Austin population: 961,855". Copy numbers EXACTLY; never round or invent. If the step established no such datum (navigation, a click), set fact to null.
```

- [ ] **Step 6: Typecheck + commit**

```bash
cd /Users/saikrishna.2177481/Documents/Spike/browser-agent-blueprint/extension
"$HOME/.nvm/versions/node/v24.16.0/bin/node" "$HOME/.nvm/versions/node/v24.16.0/bin/npx" tsc --noEmit
git add -A && git commit -m "feat(evaluator): emit an optional grounded fact per step (parseVerdict extracted + tested)"
```

---

## Task 2: Pure ledger helpers (`facts.ts`)

**Files:**
- Create: `src/agent/facts.ts`
- Test: `tests/unit/facts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/facts.test.ts
import { describe, expect, it } from 'vitest';
import { addGroundedFact, renderFacts, groundingCorpus, type Fact } from '@/agent/facts';

const OBSERVED = 'Austin had a population of 961,855 in the 2020 census.';

describe('addGroundedFact', () => {
  it('adds a fact whose numbers all appear in observed text', () => {
    const out = addGroundedFact([], { step: 's', text: 'Austin population: 961,855' }, OBSERVED);
    expect(out).toHaveLength(1);
  });
  it('rejects a fact with a number not in observed text', () => {
    const out = addGroundedFact([], { step: 's', text: 'Austin population: 1,234,567' }, OBSERVED);
    expect(out).toHaveLength(0);
  });
  it('rejects a blank fact and a duplicate', () => {
    let out = addGroundedFact([], { step: 's', text: '   ' }, OBSERVED);
    expect(out).toHaveLength(0);
    out = addGroundedFact([{ step: 's', text: 'Austin population: 961,855' }], { step: 's', text: 'Austin population: 961,855' }, OBSERVED);
    expect(out).toHaveLength(1);
  });
  it('caps the ledger, dropping the oldest', () => {
    let facts: Fact[] = [];
    for (let i = 0; i < 30; i++) facts = addGroundedFact(facts, { step: 's', text: `fact number ${i} grounded` }, `fact number ${i} grounded`, 24);
    expect(facts).toHaveLength(24);
    expect(facts[0].text).toBe('fact number 6 grounded');
  });
});

describe('renderFacts', () => {
  it('returns undefined for an empty ledger', () => {
    expect(renderFacts([])).toBeUndefined();
  });
  it('renders bullets with optional url and bounds length', () => {
    const block = renderFacts([{ step: 's', text: 'Austin: 961,855', url: 'https://x' }]);
    expect(block).toBe('- Austin: 961,855 [https://x]');
  });
});

describe('groundingCorpus', () => {
  it('includes fact texts so an evicted page still grounds the answer', () => {
    const corpus = groundingCorpus('', [{ step: 's', text: 'Denver: 715,522' }]);
    expect(corpus).toContain('715,522');
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `"$HOME/.nvm/versions/node/v24.16.0/bin/node" "$HOME/.nvm/versions/node/v24.16.0/bin/npx" vitest run tests/unit/facts.test.ts`
Expected: FAIL — module `@/agent/facts` not found.

- [ ] **Step 3: Create `src/agent/facts.ts`**

```ts
// A small, grounded, always-in-context ledger of the facts a run has established.
// Pure (no I/O) so it is trivially testable; the orchestrator owns the array + persistence.
import { ungroundedNumbers } from './verify/grounding';

export interface Fact {
  step: string;
  text: string;
  url?: string;
}

/** Append `candidate` iff its text is non-empty, FULLY grounded in `observed` (every number it
 *  asserts appears in what was read), and not already present. Returns a new bounded array
 *  (≤ max, oldest dropped). Never throws; purely additive. */
export function addGroundedFact(facts: Fact[], candidate: Fact, observed: string, max = 24): Fact[] {
  const text = candidate.text.trim();
  if (!text) return facts;
  if (ungroundedNumbers(text, observed).length) return facts;
  if (facts.some((f) => f.text === text)) return facts;
  const next = [...facts, { ...candidate, text }];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Render the ledger for the FINDINGS prompt slot. `undefined` when empty so the caller's
 *  `.filter(Boolean)` drops the section. Bounded to `maxChars` (keeps the most recent). */
export function renderFacts(facts: Fact[], maxChars = 4_000): string | undefined {
  if (!facts.length) return undefined;
  const block = facts.map((f) => `- ${f.text}${f.url ? ` [${f.url}]` : ''}`).join('\n');
  return block.length > maxChars ? block.slice(block.length - maxChars) : block;
}

/** Grounding corpus = raw observed text PLUS the durable fact texts, so a fact whose source page
 *  has been evicted from the 60K observed-text FIFO still grounds the final answer. */
export function groundingCorpus(observed: string, facts: Fact[]): string {
  return facts.length ? `${observed}\n${facts.map((f) => f.text).join('\n')}` : observed;
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `"$HOME/.nvm/versions/node/v24.16.0/bin/node" "$HOME/.nvm/versions/node/v24.16.0/bin/npx" vitest run tests/unit/facts.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(facts): pure grounded-ledger helpers (add/render/groundingCorpus)"
```

---

## Task 3: Wire the ledger into the orchestrator

**Files:**
- Modify: `src/agent/orchestrator.ts`
- Test: covered by Task 6 integration; this task is typecheck-gated.

- [ ] **Step 1: Import the helpers and the `Verdict` type**

At the top of `src/agent/orchestrator.ts`, add:

```ts
import { addGroundedFact, renderFacts, groundingCorpus, type Fact } from './facts';
```

Ensure `Verdict` is importable from the evaluator role (add `type Verdict` to the existing import from `./roles/evaluator`, or add the import if absent):

```ts
import { runEvaluator, type Verdict } from './roles/evaluator';
```

- [ ] **Step 2: Add ledger state and reset it in `start()`**

Add a field near `private observedText = '';`:

```ts
  private facts: Fact[] = [];
```

In `start()`, alongside `this.observedText = '';`, add:

```ts
    this.facts = [];
```

- [ ] **Step 3: Render the ledger into every prompt**

In `commonCtx(...)`, add to the returned object (anywhere among the fields):

```ts
      findingsBlock: renderFacts(this.facts),
```

- [ ] **Step 4: Capture a fact after each evaluation**

Add a method (near `evaluate`):

```ts
  /** Promote the evaluator's grounded datum into the durable ledger (in-memory + persisted).
   *  No-ops on a null/ungrounded/duplicate fact — purely additive. */
  private captureFact(step: Step, ev: Verdict): void {
    if (!ev.fact) return;
    const before = this.facts.length;
    this.facts = addGroundedFact(
      this.facts,
      { step: step.description, text: ev.fact, url: this.lastRead?.url },
      this.observedText,
    );
    if (this.facts.length > before) {
      const f = this.facts[this.facts.length - 1];
      void addFinding({ taskId: this.taskId, kind: 'fact', ts: Date.now(), stepId: step.id, data: f });
    }
  }
```

In `runUntilTerminal`, in the `if (execOut.result.advanceStep)` branch, immediately after `const ev = await this.evaluate(hot, step.id, execOut.result.content);`, add:

```ts
        this.captureFact(step, ev);
```

(`Step` is already used in this file via `hot.plan!.steps`; if its type isn't imported, add `import type { Step } from '@/shared/messages';` — confirm against existing imports.)

- [ ] **Step 5: Typecheck + commit**

```bash
"$HOME/.nvm/versions/node/v24.16.0/bin/node" "$HOME/.nvm/versions/node/v24.16.0/bin/npx" tsc --noEmit
git add -A && git commit -m "feat(orchestrator): grounded facts ledger — capture per step, inject every turn"
```

---

## Task 4: Ground the finish against the ledger (durability fix)

**Files:**
- Modify: `src/agent/orchestrator.ts` (`verifyFinish`)
- Test: `tests/unit/facts.test.ts` already covers `groundingCorpus`; this wires it in (typecheck-gated).

- [ ] **Step 1: Use the combined corpus in `verifyFinish`**

Find the line in `verifyFinish` that reads:

```ts
    const ungrounded = ungroundedNumbers(summary, this.observedText);
```

Replace with:

```ts
    const ungrounded = ungroundedNumbers(summary, groundingCorpus(this.observedText, this.facts));
```

- [ ] **Step 2: Typecheck + commit**

```bash
"$HOME/.nvm/versions/node/v24.16.0/bin/node" "$HOME/.nvm/versions/node/v24.16.0/bin/npx" tsc --noEmit
git add -A && git commit -m "fix(grounding): verify finish against observed-text UNION the facts ledger (survives FIFO eviction)"
```

---

## Task 5: Gate mid-plan prose answers (harness)

**Files:**
- Modify: `src/agent/orchestrator.ts` (the `if (execOut.result.advanceStep)` branch)
- Test: Task 6 integration covers the behavior; typecheck-gated here.

- [ ] **Step 1: Reject ungrounded prose before it advances the plan**

At the very top of the `if (execOut.result.advanceStep) {` block (before `const ev = await this.evaluate(...)`), insert:

```ts
        // A mid-plan PROSE answer (no tool call) is ungrounded by construction. Gate it like a
        // finish so the plan can't advance on a fabricated number; a tool-produced advance is
        // already page-grounded. The circuit breaker stops a model that loops on bad prose.
        if (execOut.tool === 'answer') {
          const ung = ungroundedNumbers(execOut.result.content ?? '', this.observedText);
          if (ung.length) {
            this.markDirty('mid-plan prose answer ungrounded');
            this.emit({ kind: 'log', ts: Date.now(), level: 'warn', message: `prose answer rejected (ungrounded: ${ung.join(', ')})` });
            const sp = await getScratchpad(this.taskId);
            await setScratchpad(
              this.taskId,
              `${sp}\n[VERIFICATION] Your answer asserted ${ung.join(', ')}, not found on any page read. Re-read the page (aria.extract) and use only on-page values, or report them as unavailable.`.slice(-12_000),
            );
            continue;
          }
        }
```

(`ungroundedNumbers`, `getScratchpad`, `setScratchpad`, `markDirty` are all already imported/used in this file.)

- [ ] **Step 2: Typecheck + commit**

```bash
"$HOME/.nvm/versions/node/v24.16.0/bin/node" "$HOME/.nvm/versions/node/v24.16.0/bin/npx" tsc --noEmit
git add -A && git commit -m "fix(harness): a mid-plan prose answer must pass the grounding gate before advancing the plan"
```

---

## Task 6: Integration — ledger retention + prose gate

**Files:**
- Modify: `tests/integration/orchestrator.test.ts`

- [ ] **Step 1: Read the existing mock harness**

Run: `"$HOME/.nvm/versions/node/v24.16.0/bin/node" "$HOME/.nvm/versions/node/v24.16.0/bin/npx" vitest run tests/integration/orchestrator.test.ts` and read the file to learn its mock-Ollama scripting pattern (how it queues planner/executor/evaluator responses).

- [ ] **Step 2: Add a retention test**

Mirror the file's existing mock pattern. Script a 3-step plan where the executor reads a different page per step and each evaluation returns a `fact` (`{"verdict":"PASS",…,"fact":"City N: <number>"}` with the number present in that step's page content). Assert that on the final turn the executor prompt (capture the messages the mock receives) contains all 3 facts in its `FINDINGS:` block:

```ts
// pseudo-shape — adapt to the file's harness
const execPrompts: string[] = [];
mockOllama.onExecutor((messages) => execPrompts.push(messages.at(-1)!.content));
// …run a 3-step scripted task where each eval returns a grounded fact…
const last = execPrompts.at(-1)!;
expect(last).toContain('FINDINGS:');
expect(last).toContain('City 1');
expect(last).toContain('City 2');
expect(last).toContain('City 3');
```

- [ ] **Step 3: Add a prose-gate test**

Script a non-final step where the executor returns prose (no tool call) asserting a number absent from any page read. Assert the plan does NOT advance that turn (the active step stays active / a `[VERIFICATION]` note is appended), and that a grounded prose answer DOES advance.

- [ ] **Step 4: Run + commit**

```bash
"$HOME/.nvm/versions/node/v24.16.0/bin/node" "$HOME/.nvm/versions/node/v24.16.0/bin/npx" vitest run tests/integration/orchestrator.test.ts
git add -A && git commit -m "test(orchestrator): ledger retains facts across steps; ungrounded prose can't advance"
```

- [ ] **Step 5: Full suite + build, then ff-merge Phase 1 to main**

```bash
"$HOME/.nvm/versions/node/v24.16.0/bin/node" "$HOME/.nvm/versions/node/v24.16.0/bin/npx" vitest run
"$HOME/.nvm/versions/node/v24.16.0/bin/node" "$HOME/.nvm/versions/node/v24.16.0/bin/npx" vite build
# merge each task branch ff-only to main per the repo convention
```

---

## Task 7: `budget.ts` — configurable, scaled window (Phase 2)

**Files:**
- Modify: `src/agent/budget.ts`
- Test: `tests/unit/budget.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/budget.test.ts
import { describe, expect, it } from 'vitest';
import { clampNumCtx, budgetsFor, capsFor, DEFAULT_NUM_CTX } from '@/agent/budget';

describe('clampNumCtx', () => {
  it('defaults when unset/invalid', () => {
    expect(clampNumCtx(undefined)).toBe(DEFAULT_NUM_CTX);
    expect(clampNumCtx(Number.NaN)).toBe(DEFAULT_NUM_CTX);
  });
  it('clamps to [8192, 131072]', () => {
    expect(clampNumCtx(1000)).toBe(8_192);
    expect(clampNumCtx(999_999)).toBe(131_072);
    expect(clampNumCtx(65_536)).toBe(65_536);
  });
});
describe('budgetsFor / capsFor scale with the window', () => {
  it('baseline at 32K, ~4x at 128K', () => {
    expect(budgetsFor(DEFAULT_NUM_CTX).executor).toBe(26_000);
    expect(budgetsFor(131_072).executor).toBe(104_000);
    expect(capsFor(DEFAULT_NUM_CTX).observed).toBe(60_000);
    expect(capsFor(131_072).page).toBe(48_000);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `"$HOME/.nvm/versions/node/v24.16.0/bin/node" "$HOME/.nvm/versions/node/v24.16.0/bin/npx" vitest run tests/unit/budget.test.ts`
Expected: FAIL — `clampNumCtx`/`budgetsFor`/`capsFor` not exported.

- [ ] **Step 3: Implement in `src/agent/budget.ts`**

Replace `export const NUM_CTX = 32_768;` with:

```ts
export const DEFAULT_NUM_CTX = 32_768;
export const MIN_NUM_CTX = 8_192;
export const MAX_NUM_CTX = 131_072; // e4b's 128K ceiling (budget.ts header)
/** Back-compat default for callers that don't thread a setting yet. */
export const NUM_CTX = DEFAULT_NUM_CTX;

/** Clamp a user-supplied window to a safe range; falls back to the proven default. */
export function clampNumCtx(n: number | undefined): number {
  if (!n || !Number.isFinite(n)) return DEFAULT_NUM_CTX;
  return Math.max(MIN_NUM_CTX, Math.min(MAX_NUM_CTX, Math.round(n)));
}
```

Replace the `BUDGETS` const with a function (and keep a default `BUDGETS` for existing references):

```ts
export function budgetsFor(numCtx: number): Record<Role, number> {
  const scale = numCtx / DEFAULT_NUM_CTX;
  return {
    planner: Math.round(30_000 * scale),
    executor: Math.round(26_000 * scale),
    evaluator: Math.round(28_000 * scale),
    compactor: Math.round(26_000 * scale),
  };
}
export const BUDGETS: Record<Role, number> = budgetsFor(DEFAULT_NUM_CTX);

/** Raw working-memory caps (chars), scaled with the window. */
export function capsFor(numCtx: number): { page: number; scratch: number; observed: number } {
  const scale = numCtx / DEFAULT_NUM_CTX;
  return { page: Math.round(12_000 * scale), scratch: Math.round(12_000 * scale), observed: Math.round(60_000 * scale) };
}
```

Change `checkBudget` to accept the window:

```ts
export function checkBudget(role: Role, prompt: string, est: TokenRatioEstimator, numCtx: number = DEFAULT_NUM_CTX): BudgetCheck {
  const tokens = est.approxTokens(prompt);
  const budget = budgetsFor(numCtx)[role];
  return { tokens, budget, overBudget: tokens > budget, shouldCompact: role === 'executor' && tokens > budget * COMPACT_TRIGGER_FRAC };
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `"$HOME/.nvm/versions/node/v24.16.0/bin/node" "$HOME/.nvm/versions/node/v24.16.0/bin/npx" vitest run tests/unit/budget.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(budget): clampNumCtx + window-scaled budgetsFor/capsFor; checkBudget takes numCtx"
```

---

## Task 8: Thread `numCtx` from settings to the roles

**Files:**
- Modify: `src/shared/messages.ts` (`Settings` + `DEFAULT_SETTINGS`)
- Modify: `src/agent/roles/{planner,executor,evaluator,compactor}.ts`
- Modify: `src/agent/orchestrator.ts`
- Test: `tests/unit/budget.test.ts` (already green); typecheck-gated for the threading.

- [ ] **Step 1: Add the setting**

In `src/shared/messages.ts`, add to the `Settings` interface:

```ts
  /** Ollama context window. Default 32768; raise only after verifying VRAM with `ollama ps`. */
  numCtx?: number;
```

In `DEFAULT_SETTINGS`, add:

```ts
  numCtx: 32_768,
```

- [ ] **Step 2: Accept `numCtx` in each role input**

In each of `planner.ts`, `executor.ts`, `evaluator.ts`, `compactor.ts`: add `numCtx?: number;` to the role's `*Input` interface, and in the `chatOnce({…})` call replace `numCtx: NUM_CTX` with:

```ts
    numCtx: input.numCtx ?? NUM_CTX,
```

(Compactor's input is passed positionally via `runCompactor({…})` — add `numCtx?: number` to its input object the same way.)

- [ ] **Step 3: Resolve once in the orchestrator and pass through**

In `orchestrator.ts` `start()`, after `this.taskId = ulid();` add:

```ts
    this.numCtx = clampNumCtx(this.opts.settings.numCtx);
```

Add the field and import:

```ts
import { clampNumCtx, budgetsFor, capsFor, NUM_CTX } from './budget';
// …
  private numCtx = NUM_CTX;
```

In each `runPlanner/runExecutor/runEvaluator/runCompactor` call site, add `numCtx: this.numCtx,` alongside `model:`. Change the `checkBudget('executor', …)` call to pass it:

```ts
    const budgetCheck = checkBudget('executor', JSON.stringify(ctx), this.est, this.numCtx);
```

- [ ] **Step 4: Typecheck + commit**

```bash
"$HOME/.nvm/versions/node/v24.16.0/bin/node" "$HOME/.nvm/versions/node/v24.16.0/bin/npx" tsc --noEmit
git add -A && git commit -m "feat(settings): thread numCtx from settings through all four roles + budget check"
```

---

## Task 9: Scale the working-memory caps + Settings UI

**Files:**
- Modify: `src/agent/orchestrator.ts` (use `capsFor`)
- Modify: `src/sidepanel/components/SettingsPanel.tsx`

- [ ] **Step 1: Derive the caps from the window**

In `orchestrator.ts`, add a field `private caps = capsFor(NUM_CTX);` and set it in `start()` after `this.numCtx = …`:

```ts
    this.caps = capsFor(this.numCtx);
```

Replace the three hard-coded literals:
- `lastRead` content `.slice(0, 12_000)` → `.slice(0, this.caps.page)`
- the scratchpad `.slice(-12_000)` writes → `.slice(-this.caps.scratch)` (there are a few; update each)
- `observedText` `.slice(-60_000)` → `.slice(-this.caps.observed)`

- [ ] **Step 2: Add the Settings field**

In `SettingsPanel.tsx`, mirror an existing numeric/text setting field. Add a "Context window (num_ctx)" number input bound to `settings.numCtx` (default 32768), with help text:

> "Larger = better long-task memory but more VRAM. On a 16 GB box, raise in steps (32768 → 65536 → 131072) and check `ollama ps` shows the model at ~100% GPU with no CPU spill after each change. If a task fails to start or slows sharply, lower it back."

- [ ] **Step 3: Typecheck + build + commit**

```bash
"$HOME/.nvm/versions/node/v24.16.0/bin/node" "$HOME/.nvm/versions/node/v24.16.0/bin/npx" tsc --noEmit
"$HOME/.nvm/versions/node/v24.16.0/bin/node" "$HOME/.nvm/versions/node/v24.16.0/bin/npx" vite build
git add -A && git commit -m "feat(settings): scale working-memory caps with numCtx + UI field with VRAM-staging guidance"
```

- [ ] **Step 4: Full suite, then ff-merge Phase 2 to main**

```bash
"$HOME/.nvm/versions/node/v24.16.0/bin/node" "$HOME/.nvm/versions/node/v24.16.0/bin/npx" vitest run
```

---

## Post-implementation: user hardware verification (Phase 2)

The default stays 32768, so nothing changes until you opt up. To raise it:
1. Set num_ctx to 65536 in Settings; reload the extension; run a real long task.
2. Run `! ollama ps` — confirm the model shows ~100% GPU (no CPU %) and PROCESSOR fits.
3. If clean, repeat at 131072. If it spills to CPU or a task won't start, drop back one level.

This cannot be verified from the build sandbox (no Ollama socket) — it is a manual step on the 16 GB box.

---

## Self-Review

**Spec coverage:**
- Ledger state/capture/inject → Tasks 1–3. ✓
- Grounded capture (`ungroundedNumbers`) → Task 2 (`addGroundedFact`) + Task 1 (evaluator fact). ✓
- Finish grounding vs ledger ∪ observedText → Task 4. ✓
- Mid-plan prose grounding gate → Task 5. ✓
- Bounded/deduped ledger → Task 2 tests. ✓
- Phase 2 configurable/scaled/clamped window + UI + staging → Tasks 7–9 + verification section. ✓
- Resume-rehydration → intentionally dropped (documented in the header note; no seamless loop-resume exists). Spec deviation is explicit, not a gap.

**Placeholder scan:** Integration steps (Task 6) reference "the file's harness pattern" rather than exact mock code, because that harness must be read first (Task 6 Step 1) — this is a read-then-mirror instruction, not a TODO. All pure-logic tasks (1, 2, 7) and all production edits have complete code.

**Type consistency:** `Fact` (`{step, text, url?}`) is used identically in `facts.ts`, `captureFact`, and `addFinding` data. `Verdict.fact: string | null` flows evaluator → `captureFact`. `clampNumCtx`/`budgetsFor`/`capsFor`/`checkBudget(…, numCtx)` signatures match between Task 7 (definition) and Task 8 (use). `this.numCtx`/`this.caps` defined in Task 8/9 before use.
