# Theme A — Page-Grounded Verification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agent verify answers against the actual page before accepting them — the Evaluator reads the page, and a `finish(success)` is grounding-checked (with bounded self-correction) before it's returned.

**Architecture:** Reuse the benchmark's grounding detector in production (shared module). Feed the already-plumbed page content into the Evaluator prompt. Accumulate a per-task corpus of everything read, and gate the executor's direct `finish` through a deterministic number check + a page-aware LLM verify; on failure, nudge the executor to correct (bounded), else downgrade to `partial`.

**Tech Stack:** TypeScript, Vitest (happy-dom), local Ollama (`gemma4:e4b`). Run tests with the nvm Node 24 binary:
`/Users/saikrishna.2177481/.nvm/versions/node/v24.16.0/bin/node extension/node_modules/.bin/vitest run --root extension <path>`

**Spec:** `docs/superpowers/specs/2026-06-18-theme-a-page-grounded-verification-design.md`

---

## File Structure

- **Create** `extension/src/agent/verify/grounding.ts` — pure grounding helpers (`dataNumbers`, `ungroundedNumbers`, `normNum`), shared by prod + bench.
- **Create** `extension/src/agent/verify/grounding.test.ts` — unit tests for the helpers (moved out of the bench scorer test).
- **Modify** `extension/tests/bench/scorer.ts` — import the helpers from the shared module; delete the local copies.
- **Modify** `extension/tests/bench/scorer.test.ts` — drop the moved describe blocks; keep `scoreRun` tests.
- **Create** `extension/tests/unit/evaluator_prompt.test.ts` — asserts the Evaluator prompt is page-aware.
- **Modify** `extension/src/agent/prompts/index.ts` — `buildEvaluatorMessages` includes `pageContentBlock` + a verification rule.
- **Modify** `extension/src/agent/orchestrator.ts` — observed-text corpus, `verifyFinish`, self-correcting finish gate.
- **Modify** `extension/tests/integration/orchestrator.test.ts` — tests for the finish gate.

All paths below are relative to the repo root. The vitest filter paths are relative to `extension` (because of `--root extension`).

---

## Task 1: Shared grounding module

**Files:**
- Create: `extension/src/agent/verify/grounding.ts`
- Create: `extension/src/agent/verify/grounding.test.ts`
- Modify: `extension/tests/bench/scorer.ts`
- Modify: `extension/tests/bench/scorer.test.ts`

- [ ] **Step 1: Write the failing test for the new module**

Create `extension/src/agent/verify/grounding.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { dataNumbers, ungroundedNumbers } from './grounding';

const PAGES = 'Logitech M185 Wireless Mouse Price: $13.42 Rating: 4.6 out of 5 stars';

describe('dataNumbers', () => {
  it('extracts prices, decimals and multi-digit ints; ignores single-digit list markers', () => {
    expect(dataNumbers('1. M185 $13.42 rated 4.6')).toEqual(['13.42', '4.6']);
    expect(dataNumbers('top 3 results')).toEqual([]); // "3" is a single digit → ignored
    expect(dataNumbers('year 2025')).toEqual(['2025']);
  });
});

describe('ungroundedNumbers', () => {
  it('flags a number absent from observed text (hallucination), passes a present one', () => {
    expect(ungroundedNumbers('It costs $13.42', PAGES)).toEqual([]);
    expect(ungroundedNumbers('It costs $99.99', PAGES)).toEqual(['99.99']);
  });
});
```

- [ ] **Step 2: Run it — verify it fails (module missing)**

Run: `/Users/saikrishna.2177481/.nvm/versions/node/v24.16.0/bin/node extension/node_modules/.bin/vitest run --root extension src/agent/verify/grounding.test.ts`
Expected: FAIL — cannot resolve `./grounding`.

- [ ] **Step 3: Create the module**

Create `extension/src/agent/verify/grounding.ts`:

```ts
// Pure grounding helpers shared by the live finish-verifier and the benchmark scorer.
// "Grounded" = every number an answer asserts actually appeared in the text the agent
// read. Bare single digits ("1.", "top 3") are intentionally NOT treated as data, so
// list markers never look like hallucinations.

const NUM_RE = /\$\s?\d[\d,]*(?:\.\d+)?|\b\d+\.\d+\b|\b\d{2,}\b/g;

export function normNum(tok: string): string {
  return tok.replace(/[$\s,]/g, '');
}

export function dataNumbers(s: string): string[] {
  const m = s.match(NUM_RE);
  if (!m) return [];
  return [...new Set(m.map(normNum))];
}

/** Numbers in `text` that do NOT appear anywhere in `observed`. */
export function ungroundedNumbers(text: string, observed: string): string[] {
  const obs = observed.replace(/[$\s,]/g, '');
  return dataNumbers(text).filter((n) => !obs.includes(n));
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `/Users/saikrishna.2177481/.nvm/versions/node/v24.16.0/bin/node extension/node_modules/.bin/vitest run --root extension src/agent/verify/grounding.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Point the bench scorer at the shared module**

In `extension/tests/bench/scorer.ts`, delete the local `NUM_RE`, `normNum`, `dataNumbers`, and `ungroundedNumbers` definitions (the block from the `NUM_RE` comment through the end of `ungroundedNumbers`) and add this import below the existing `import type { Expectation } from './fixtures';`:

```ts
import { dataNumbers, ungroundedNumbers } from '@/agent/verify/grounding';
```

`dataNumbers` is imported because the file re-exports nothing else that needs it — keep the import even if only `ungroundedNumbers` is referenced by `scoreRun`, so the bench's behavior is unchanged. If your linter objects to an unused import, drop `dataNumbers` from the import (it is only used in tests now). `scoreRun` and its `ungroundedNumbers(run.summary, run.observedText)` call stay exactly as they are.

- [ ] **Step 6: Move the helper tests out of the scorer test**

In `extension/tests/bench/scorer.test.ts`:
- Change the import line to drop the moved helpers:

```ts
import { scoreRun, type BenchRun } from './scorer';
```

- Delete the `describe('dataNumbers', …)` and `describe('ungroundedNumbers', …)` blocks (they now live in `grounding.test.ts`). Keep the `describe('scoreRun', …)` block and the `run()` helper unchanged.

- [ ] **Step 7: Run the full bench suite + typecheck**

Run: `/Users/saikrishna.2177481/.nvm/versions/node/v24.16.0/bin/node extension/node_modules/.bin/vitest run --root extension tests/bench src/agent/verify`
Expected: PASS (bench suite + grounding tests; the `run.bench` live test stays skipped).
Run: `/Users/saikrishna.2177481/.nvm/versions/node/v24.16.0/bin/node extension/node_modules/.bin/tsc --noEmit -p extension/tsconfig.json`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add extension/src/agent/verify/grounding.ts extension/src/agent/verify/grounding.test.ts extension/tests/bench/scorer.ts extension/tests/bench/scorer.test.ts
git commit -m "refactor(verify): extract grounding helpers into a shared module"
```

---

## Task 2: Page-aware Evaluator prompt

**Files:**
- Create: `extension/tests/unit/evaluator_prompt.test.ts`
- Modify: `extension/src/agent/prompts/index.ts` (`buildEvaluatorMessages`)

- [ ] **Step 1: Write the failing test**

Create `extension/tests/unit/evaluator_prompt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildEvaluatorMessages, type CommonContext } from '@/agent/prompts';
import type { Step } from '@/shared/messages';

const step: Step = { id: 's1', description: 'read product', successCriteria: 'price found', status: 'active' };
const baseCtx: CommonContext = {
  goal: 'find the price',
  toolCatalog: '',
  plan: null,
  currentStepId: 's1',
  ownedTabs: [],
};

describe('buildEvaluatorMessages — page-aware', () => {
  it('includes CURRENT PAGE CONTENT when pageContentBlock is set', () => {
    const msgs = buildEvaluatorMessages(
      { ...baseCtx, pageContentBlock: 'PAGE: price £10.00' },
      'I found £10.00',
      step,
    );
    const user = msgs.find((m) => m.role === 'user')!.content;
    expect(user).toContain('CURRENT PAGE CONTENT');
    expect(user).toContain('price £10.00');
  });

  it('instructs the evaluator to verify claims against the page', () => {
    const msgs = buildEvaluatorMessages({ ...baseCtx, pageContentBlock: 'x' }, 'r', step);
    const sys = msgs.find((m) => m.role === 'system')!.content;
    expect(sys).toMatch(/not present in the page|unsupported claim|verify .*against the page/i);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `/Users/saikrishna.2177481/.nvm/versions/node/v24.16.0/bin/node extension/node_modules/.bin/vitest run --root extension tests/unit/evaluator_prompt.test.ts`
Expected: FAIL — user message lacks "CURRENT PAGE CONTENT"; system lacks the rule.

- [ ] **Step 3: Make the Evaluator prompt page-aware**

In `extension/src/agent/prompts/index.ts`, inside `buildEvaluatorMessages`:

(a) Add a verification rule to the system prompt. After the bullet that begins `- An error/empty page is NOT success:`, insert:

```
- VERIFY against the page: CURRENT PAGE CONTENT below (when present) is the ACTUAL page. If the result asserts a specific fact, number, or rating that is NOT present there, the step has NOT succeeded — verdict FAIL and name the unsupported claim. Never trust the executor's summary over the page.
```

(b) Add the page content to the user message. Change the `user` array so the `MOST RECENT EXECUTOR OUTPUT` entry is followed by the page block:

```ts
  const user = [
    `GOAL: ${ctx.goal}`,
    `ACTIVE STEP: ${step.description}`,
    `SUCCESS CRITERIA: ${step.successCriteria}`,
    ctx.recentActions ? `ACTIONS TAKEN THIS STEP (judge the whole sequence, not just the last):\n${ctx.recentActions}` : '',
    `MOST RECENT EXECUTOR OUTPUT:\n${lastResult.slice(0, 4_000)}`,
    ctx.pageContentBlock
      ? `CURRENT PAGE CONTENT (the actual page — verify the result's claims against THIS, not the executor's words):\n${ctx.pageContentBlock}`
      : '',
    ctx.findingsBlock ? `FINDINGS:\n${ctx.findingsBlock}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
```

- [ ] **Step 4: Run it — verify it passes**

Run: `/Users/saikrishna.2177481/.nvm/versions/node/v24.16.0/bin/node extension/node_modules/.bin/vitest run --root extension tests/unit/evaluator_prompt.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the integration suite (existing evaluator tests must still pass)**

Run: `/Users/saikrishna.2177481/.nvm/versions/node/v24.16.0/bin/node extension/node_modules/.bin/vitest run --root extension tests/integration/orchestrator.test.ts`
Expected: PASS (the fake Ollama matches on "You are the EVALUATOR"; the additive prompt change doesn't affect it).

- [ ] **Step 6: Commit**

```bash
git add extension/src/agent/prompts/index.ts extension/tests/unit/evaluator_prompt.test.ts
git commit -m "feat(agent): make the Evaluator verify claims against the page"
```

---

## Task 3: Verified finish with bounded self-correction

**Files:**
- Modify: `extension/src/agent/orchestrator.ts`
- Modify: `extension/tests/integration/orchestrator.test.ts`

This task adds (a) a per-task observed-text corpus, (b) a `verifyFinish` method (deterministic number check + page-aware LLM verify), and (c) a self-correcting finish gate.

- [ ] **Step 1: Write the failing tests**

Append to `extension/tests/integration/orchestrator.test.ts` (the `buildRegistry`, `makeFakeOllama`, `rawResponse`, `DEFAULT_SETTINGS`, `Orchestrator` imports already exist at the top of the file):

```ts
describe('orchestrator — verified finish', () => {
  function pageReg(content: string) {
    const reg = buildRegistry();
    reg.register({
      name: 'aria.extract',
      description: 'extract the page',
      argsSchema: z.object({ tabId: z.number().int().optional() }),
      async dispatch() {
        return { ok: true, content, data: { url: 'https://x/' } };
      },
    });
    return reg;
  }

  it('downgrades to partial when a finish asserts a number not on any page read', async () => {
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'read and report', successCriteria: 'done' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'The price is £99.99' } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'The price is £99.99' } }] }),
      ],
      evaluator: [],
    });
    const orch = new Orchestrator({ ollama, registry: pageReg('Widget — in stock, no price shown'), settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const result = await orch.runUntilTerminal(await orch.start('report the price'));
    expect(result.verdict).toBe('partial');
    expect(result.summary).toContain('unverified against page');
  });

  it('accepts a finish whose numbers are all grounded (after the LLM verify passes)', async () => {
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'read and report', successCriteria: 'done' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'The price is £99.99' } }] }),
      ],
      evaluator: [
        rawResponse({ content: JSON.stringify({ verdict: 'PASS', reason: 'grounded', shouldReplan: false, finishVerdict: null, finishSummary: null }) }),
      ],
    });
    const orch = new Orchestrator({ ollama, registry: pageReg('Widget price £99.99 in stock'), settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const result = await orch.runUntilTerminal(await orch.start('report the price'));
    expect(result.verdict).toBe('success');
  });

  it('skips verification for an honest blocked finish', async () => {
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'find it', successCriteria: 'done' }] }) })],
      executor: [rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'blocked', summary: 'No such product was found.' } }] })],
      evaluator: [],
    });
    const orch = new Orchestrator({ ollama, registry: pageReg('anything'), settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const result = await orch.runUntilTerminal(await orch.start('find the blender'));
    expect(result.verdict).toBe('blocked');
  });

  it('self-corrects: a textual fabrication is rejected, then an honest re-finish passes', async () => {
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'read and report', successCriteria: 'done' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'Rating: 5 stars' } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'Rating: not available on the page' } }] }),
      ],
      evaluator: [
        rawResponse({ content: JSON.stringify({ verdict: 'FAIL', reason: 'no rating on the page', shouldReplan: false, finishVerdict: null, finishSummary: null }) }),
        rawResponse({ content: JSON.stringify({ verdict: 'PASS', reason: 'grounded', shouldReplan: false, finishVerdict: null, finishSummary: null }) }),
      ],
    });
    const orch = new Orchestrator({ ollama, registry: pageReg('Widget price £10.00 in stock'), settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const result = await orch.runUntilTerminal(await orch.start('report the rating'));
    expect(result.verdict).toBe('success');
    expect(result.summary).toContain('not available');
  });
});
```

- [ ] **Step 2: Run them — verify they fail**

Run: `/Users/saikrishna.2177481/.nvm/versions/node/v24.16.0/bin/node extension/node_modules/.bin/vitest run --root extension tests/integration/orchestrator.test.ts -t "verified finish"`
Expected: FAIL — today every `finish` is accepted verbatim, so the first test gets `verdict==='success'` (not `partial`), and the self-correct test ends on the fabricated summary.

- [ ] **Step 3: Add the imports and per-task state**

In `extension/src/agent/orchestrator.ts`:

(a) Extend the messages import to include `Step`:

```ts
import type { Plan, Settings, Step, TimelineEvent } from '@/shared/messages';
```

(b) Add the grounding import next to the other agent imports (near the `import { redact, redactDeep } …` line):

```ts
import { ungroundedNumbers } from './verify/grounding';
```

(c) Add two fields to the class, next to `private lastRead …`:

```ts
  // Everything read this task (capped), the corpus the finish-verifier grounds against.
  private observedText = '';
  // How many times a success finish failed verification this task (bounds the self-correct loop).
  private verifyAttempts = 0;
```

(d) Reset them in `start()`, alongside `this.lastRead = null;`:

```ts
    this.observedText = '';
    this.verifyAttempts = 0;
```

- [ ] **Step 4: Accumulate the observed-text corpus**

In `extension/src/agent/orchestrator.ts`, add this helper method (place it just above `commonCtx`):

```ts
  private recordObserved(content: string): void {
    if (!content) return;
    this.observedText = `${this.observedText}\n${content}`.slice(-60_000);
  }
```

Call it in two places in `executeOne`:

(i) In the post-navigation auto-read success branch, right after `this.lastObserveTool = 'aria.extract';`:

```ts
        this.recordObserved(obs.content);
```

(ii) In the `READING_TOOLS` block, right after the `this.lastRead = { tool: out.tool, url, content: … };` assignment:

```ts
      this.recordObserved(out.result.content ?? '');
```

- [ ] **Step 5: Add the `verifyFinish` method**

In `extension/src/agent/orchestrator.ts`, add this method (place it just above `private async finishOk(`):

```ts
  /** Verify a success answer is grounded in what was actually read.
   *  Fast deterministic number check first; then a page-aware LLM verify. */
  private async verifyFinish(hot: AgentStateHot, summary: string): Promise<{ ok: boolean; reason: string }> {
    const ungrounded = ungroundedNumbers(summary, this.observedText);
    if (ungrounded.length) {
      return { ok: false, reason: `value(s) not found on any page read: ${ungrounded.join(', ')}` };
    }
    try {
      const verifyStep: Step = {
        id: 'verify',
        description: 'Verify the final answer is fully supported by the page content',
        successCriteria: 'every specific fact, number, and rating in the answer appears in CURRENT PAGE CONTENT',
        status: 'active',
      };
      const ev = await runEvaluator({
        ctx: this.commonCtx(hot),
        model: this.opts.settings.evaluatorModel,
        ollama: this.opts.ollama,
        lastExecutorResult: summary,
        step: verifyStep,
        signal: this.signal,
      });
      if (ev.verdict === 'FAIL') return { ok: false, reason: ev.reason };
      return { ok: true, reason: '' };
    } catch (err) {
      // A flaky verifier must not trap a finished task — accept, but surface it.
      this.emit({ kind: 'log', ts: Date.now(), level: 'warn', message: `finish verifier errored, accepting: ${(err as Error).message}` });
      return { ok: true, reason: '' };
    }
  }
```

- [ ] **Step 6: Gate the executor-initiated finish**

In `extension/src/agent/orchestrator.ts`, replace the finish block in `runUntilTerminal`:

```ts
      if (execOut.result.finish) {
        return this.finishOk(hot, execOut.result.finish.verdict, execOut.result.finish.summary);
      }
```

with the gated version:

```ts
      if (execOut.result.finish) {
        const fin = execOut.result.finish;
        // Honest failures aren't fabrication risks — accept them as-is.
        if (fin.verdict !== 'success') {
          return this.finishOk(hot, fin.verdict, fin.summary);
        }
        const v = await this.verifyFinish(hot, fin.summary);
        if (v.ok) {
          return this.finishOk(hot, 'success', fin.summary);
        }
        this.verifyAttempts += 1;
        this.emit({ kind: 'log', ts: Date.now(), level: 'warn', message: `finish rejected (attempt ${this.verifyAttempts}): ${v.reason}` });
        if (this.verifyAttempts >= 2) {
          return this.finishOk(hot, 'partial', `${fin.summary}\n\n[unverified against page: ${v.reason}]`);
        }
        // Corrective turn: nudge the executor to re-read or report honestly, then retry.
        const sp = await getScratchpad(this.taskId);
        await setScratchpad(
          this.taskId,
          `${sp}\n[VERIFICATION] Your finish was rejected: ${v.reason}. Re-read the page (aria.extract / vision.read) and correct the answer, or report those value(s) as not available on the page. Do NOT repeat the unsupported claim.`.slice(-12_000),
        );
        continue;
      }
```

(`getScratchpad` and `setScratchpad` are already imported at the top of the file.)

- [ ] **Step 7: Run the new tests — verify they pass**

Run: `/Users/saikrishna.2177481/.nvm/versions/node/v24.16.0/bin/node extension/node_modules/.bin/vitest run --root extension tests/integration/orchestrator.test.ts -t "verified finish"`
Expected: PASS (4 tests).

- [ ] **Step 8: Run the full suite + typecheck**

Run: `/Users/saikrishna.2177481/.nvm/versions/node/v24.16.0/bin/node extension/node_modules/.bin/vitest run --root extension`
Expected: PASS (all prior tests + the new ones; 1 skipped live bench).
Run: `/Users/saikrishna.2177481/.nvm/versions/node/v24.16.0/bin/node extension/node_modules/.bin/tsc --noEmit -p extension/tsconfig.json`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add extension/src/agent/orchestrator.ts extension/tests/integration/orchestrator.test.ts
git commit -m "feat(agent): verify finish answers against the page, with bounded self-correction"
```

---

## Task 4: Build + benchmark verification (live, user-run)

**Files:** none (verification only).

- [ ] **Step 1: Production build**

Run: `cd extension && /Users/saikrishna.2177481/.nvm/versions/node/v24.16.0/bin/node node_modules/.bin/vite build`
Expected: `✓ built` with no errors (the chunk-size warning is pre-existing).

- [ ] **Step 2: Benchmark — no regression (USER runs; needs `ollama serve`)**

Run: `cd extension && OLLAMA_BENCH=1 OLLAMA_BENCH_TRIALS=1 npm run bench`
Expected: `grounded` stays 100%; `completed`/`correct` no worse than the prior baseline (80/80). The extra verify call adds latency per successful task — watch for any task newly tripping the per-task timeout; if so, note it (don't treat as an accuracy regression).

- [ ] **Step 3: Targeted check of the honest-gap fixture (USER runs)**

Run: `cd extension && OLLAMA_BENCH=1 OLLAMA_BENCH_TASK=field-absent npm run bench`
Expected: `field-absent` stays `grounded=true` and `correct=true` — verification is a safety net that doesn't break the case that already worked.

- [ ] **Step 4: Live browser smoke (USER runs, optional)**

Reload `extension/dist` and re-run the books.toscrape goal. Expect the same honest rating answer, plus — if the executor ever fabricates — a `WARN finish rejected …` line in the timeline followed by a corrected/`partial` result.

---

## Self-Review

- **Spec coverage:** §Design.1 (shared module) → Task 1. §Design.2 (corpus) → Task 3 Steps 3–4. §Design.3 (page-aware Evaluator) → Task 2. §Design.4 (verified finish + self-correct) → Task 3 Steps 5–6. §Testing → Tasks 1–3 unit/integration + Task 4 bench. §Error handling (verifier error = accept+warn; honest failures skip) → `verifyFinish` catch + the `fin.verdict !== 'success'` guard. All covered.
- **Placeholder scan:** none — every step has full code or an exact command.
- **Type consistency:** `verifyFinish(hot, summary) → {ok, reason}` used consistently; `ungroundedNumbers(text, observed)` matches the module signature; `Step` shape (`id/description/successCriteria/status`) matches `@/shared/messages`; `runEvaluator` input shape matches `roles/evaluator.ts`.
- **Ambiguity:** the corrective note is delivered via the scratchpad (existing plumbing, shown to the executor) — chosen over a new CommonContext field to keep surface small.
