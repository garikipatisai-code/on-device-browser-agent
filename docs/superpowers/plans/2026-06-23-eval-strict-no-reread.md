# Evaluator Strictness + No Redundant Re-reads — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the evaluator judge the *active step's* specific datum (not "any data exists"), and stop the executor from redundantly re-reading a page the harness already auto-read after navigation.

**Architecture:** Two prompt-only rewrites in `src/agent/prompts/index.ts` (the evaluator system prompt + one executor rule), locked with content-assertion unit tests on the prompt builders. No code/control-flow/output-shape changes. Real proof is the live re-run.

**Tech Stack:** TypeScript, Vitest. Build/test from `extension/` via `"$HOME/.nvm/versions/node/v24.16.0/bin/node" "$HOME/.nvm/versions/node/v24.16.0/bin/npx" <vitest|tsc|vite>`.

**Conventions:** Branch `feat/eval-strict-no-reread` off `main`; TDD (failing content test → reword prompt → green); ff-merge to `main` when green. Spec: `docs/superpowers/specs/2026-06-23-eval-strictness-and-redundant-reads-design.md`.

---

## File Structure

- `src/agent/prompts/index.ts` — modify the evaluator system prompt (Task 1) and one executor rule (Task 2). Both builders (`buildEvaluatorMessages`, `buildExecutorMessages`) are already exported.
- `tests/unit/prompts_content.test.ts` *(new)* — content assertions on the two builders' system strings.

> Note: if a brand-new test file fails to resolve the `@/` alias (a hiccup seen before), colocate these cases in an existing `tests/unit/*.test.ts` that already imports from `@/agent`.

---

## Task 1: Evaluator judges the active step's specific datum

**Files:**
- Create: `tests/unit/prompts_content.test.ts`
- Modify: `src/agent/prompts/index.ts` (`buildEvaluatorMessages` system prompt — the bullet that currently starts "The agent gathers a step's data and then MOVES ON…", and the `SCRATCHPAD (…)` user-block framing)

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/prompts_content.test.ts
import { describe, it, expect } from 'vitest';
import { buildEvaluatorMessages, buildExecutorMessages } from '@/agent/prompts';
import type { Step } from '@/shared/messages';

// Minimal fixtures — adjust field names only if the compiler complains.
const ctx = { goal: 'compare city populations', toolCatalog: '(tools)', plan: null, currentStepId: null, ownedTabs: [] } as Parameters<typeof buildEvaluatorMessages>[0];
const step = { id: 's1', description: "find São Paulo's population", successCriteria: "São Paulo's population is recorded", status: 'active' } as unknown as Step;

describe('evaluator prompt: judges the active step’s specific datum', () => {
  const sys = buildEvaluatorMessages(ctx, 'last result', step)[0].content as string;
  it('requires THIS step’s specific item, not any data', () => {
    expect(sys).toContain("THIS step's specific item");
    expect(sys).toContain('another city'); // the anti-hand-wave example
  });
  it('requires the reason to name the active step’s value', () => {
    expect(sys).toMatch(/reason[^.]{0,40}quote/i);
  });
  it('still protects earlier-gathered data (no re-fail)', () => {
    expect(sys.toLowerCase()).toContain('earlier turn');
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `"$HOME/.nvm/versions/node/v24.16.0/bin/node" "$HOME/.nvm/versions/node/v24.16.0/bin/npx" vitest run tests/unit/prompts_content.test.ts`
Expected: FAIL — current prompt has no "THIS step's specific item" / "another city" / "reason … quote".

- [ ] **Step 3: Reword the evaluator prompt**

In `src/agent/prompts/index.ts`, `buildEvaluatorMessages`, REPLACE the bullet:
```ts
- The agent gathers a step's data and then MOVES ON to later steps. CHECK THE SCRATCHPAD + ACTIONS below — they log what was gathered on earlier turns. A step is DONE (PASS) if its objective appears anywhere there, even if CURRENT PAGE CONTENT is now a different/later page (e.g. the step wanted Austin's population, the scratchpad shows it was extracted, and the agent has since moved on to Denver → PASS, not FAIL). Do NOT FAIL a step just because the current page moved on; FAIL only if its data was NEVER gathered this task.
```
with:
```ts
- The agent gathers a step's data and then MOVES ON to later steps. CHECK THE SCRATCHPAD + ACTIONS + FINDINGS below — they log what was gathered on earlier turns, and data gathered on an EARLIER turn STILL counts (do NOT re-FAIL it just because CURRENT PAGE CONTENT is now a later page). BUT it must be THIS step's specific item: PASS only if the exact datum the ACTIVE STEP asked for is present (e.g. for "find São Paulo's population", São Paulo's population must be there — do NOT PASS by citing another city's number that was gathered for a different step). Your `reason` MUST quote the active step's specific value. FAIL only if THIS step's specific data was never gathered this task.
```

Then REPLACE the scratchpad user-block framing:
```ts
    ctx.scratchpad ? `SCRATCHPAD (everything gathered so far this task — earlier turns' reads + findings; a step counts as DONE if its data appears here, even if the current page has moved on):\n${ctx.scratchpad}` : '',
```
with:
```ts
    ctx.scratchpad ? `SCRATCHPAD (everything gathered so far this task — earlier turns' reads + findings; the ACTIVE step counts as DONE only if THAT step's own datum appears here, not merely some other step's):\n${ctx.scratchpad}` : '',
```

Leave everything else in `buildEvaluatorMessages` unchanged (output shape, `finishVerdict`, `fact`, the error/empty-page FAIL rule, the page-grounding rule, the "fair, not pedantic" line, and the overshoot/ahead-of-plan PASS rule).

- [ ] **Step 4: Run it — expect PASS**

Run: `"$HOME/.nvm/versions/node/v24.16.0/bin/node" "$HOME/.nvm/versions/node/v24.16.0/bin/npx" vitest run tests/unit/prompts_content.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
cd /Users/saikrishna.2177481/Documents/Spike/browser-agent-blueprint/extension
"$HOME/.nvm/versions/node/v24.16.0/bin/node" "$HOME/.nvm/versions/node/v24.16.0/bin/npx" tsc --noEmit
git add -A && git commit -m "fix(evaluator): judge the active step's specific datum (not 'any data exists'), keep no-re-fail"
```

---

## Task 2: Executor stops redundant re-reads after navigation

**Files:**
- Modify: `src/agent/prompts/index.ts` (`buildExecutorMessages` — the rule that currently says "after opening a page call tab.wait_loaded, then aria.extract")
- Test: `tests/unit/prompts_content.test.ts` (append a describe)

- [ ] **Step 1: Append the failing test**

Add to `tests/unit/prompts_content.test.ts`:
```ts
describe('executor prompt: page is auto-read after navigation (no redundant re-read)', () => {
  const sys = buildExecutorMessages(ctx)[0].content as string;
  it('states the new page is auto-read and not to re-call wait_loaded/aria.extract', () => {
    expect(sys).toContain('AUTO-READ');
    expect(sys).toMatch(/do NOT call tab\.wait_loaded or aria\.extract again/);
  });
  it('removed the old contradictory "after opening … call tab.wait_loaded, then aria.extract" instruction', () => {
    expect(sys).not.toMatch(/after opening a page call tab\.wait_loaded, then aria\.extract/);
  });
  it('keeps the legitimate in-place re-extract case', () => {
    expect(sys.toLowerCase()).toMatch(/in place|did not navigate|filter|sort/);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `"$HOME/.nvm/versions/node/v24.16.0/bin/node" "$HOME/.nvm/versions/node/v24.16.0/bin/npx" vitest run tests/unit/prompts_content.test.ts`
Expected: the new describe FAILs (old instruction still present, no "AUTO-READ").

- [ ] **Step 3: Reword the executor rule**

In `src/agent/prompts/index.ts`, `buildExecutorMessages`, REPLACE the rule:
```ts
- Read before you act: after opening a page call tab.wait_loaded, then aria.extract — do this before you click, type, or scroll.
```
with:
```ts
- After you open a result, open a tab, or click a link, the new page is AUTO-READ for you and appears below as CURRENT PAGE CONTENT — do NOT call tab.wait_loaded or aria.extract again. Observe by reading CURRENT PAGE CONTENT before you click/type/scroll. Re-extract with aria.extract ONLY when the element you need is missing/stale because YOU changed the page in place (a filter/sort/expand/"load more" that did not navigate).
```

Leave the related rules (the "do NOT re-extract a page you have already read" and the CURRENT PAGE CONTENT "re-extract only if you have navigated since" lines) as-is — they now agree with this rule.

- [ ] **Step 4: Run it — expect PASS**

Run: `"$HOME/.nvm/versions/node/v24.16.0/bin/node" "$HOME/.nvm/versions/node/v24.16.0/bin/npx" vitest run tests/unit/prompts_content.test.ts`
Expected: PASS (6 tests total).

- [ ] **Step 5: Typecheck + commit**

```bash
"$HOME/.nvm/versions/node/v24.16.0/bin/node" "$HOME/.nvm/versions/node/v24.16.0/bin/npx" tsc --noEmit
git add -A && git commit -m "fix(executor): page is auto-read after navigation — stop redundant tab.wait_loaded/aria.extract"
```

---

## Task 3: Full suite + build, then ff-merge

- [ ] **Step 1: Full suite + tsc + build (all green)**

```bash
"$HOME/.nvm/versions/node/v24.16.0/bin/node" "$HOME/.nvm/versions/node/v24.16.0/bin/npx" vitest run
"$HOME/.nvm/versions/node/v24.16.0/bin/node" "$HOME/.nvm/versions/node/v24.16.0/bin/npx" tsc --noEmit
"$HOME/.nvm/versions/node/v24.16.0/bin/node" "$HOME/.nvm/versions/node/v24.16.0/bin/npx" vite build
```
Expected: full suite green (routing matrix + all prior tests unaffected — prompt-only change); tsc clean; build OK. (If only `tests/property/properties.test.ts` flickers, re-run once — known historically; should be deterministic now.)

- [ ] **Step 2: ff-merge to main + prune**

```bash
git switch main && git merge --ff-only feat/eval-strict-no-reread && git branch -d feat/eval-strict-no-reread
```

---

## Self-Review

**Spec coverage:** Component 1 (evaluator active-step specificity, keep no-re-fail + fair-not-pedantic, reason names the value) → Task 1. Component 2 (auto-read after nav, kill redundant wait_loaded/extract, keep in-place re-extract) → Task 2. "Full suite + routing matrix stay green" → Task 3. "Explicitly NOT doing" (no output-shape/cadence/code change) → respected (prompt-only edits; tests assert only string content). ✓

**Placeholder scan:** none — exact before/after strings and exact test code given. The fixture note ("adjust field names only if the compiler complains") is a real type-safety hedge, not a TODO.

**Type consistency:** `buildEvaluatorMessages(ctx, lastResult, step)` and `buildExecutorMessages(ctx)` match their existing signatures; `ctx`/`step` fixtures are cast to the builders' parameter types. Test file imports both builders from `@/agent/prompts`. The `[0].content as string` access matches the `ChatMessage[]` return shape.
