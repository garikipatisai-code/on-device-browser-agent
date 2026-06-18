# Theme A — Page-Grounded Verification

**Date:** 2026-06-18
**Status:** Approved (design); implementation pending
**Branch:** `feat/theme-a-page-grounded-verification`

## Context & problem

The benchmark proved the agent's accuracy is strong on what it reads, but the live books.toscrape test exposed the failure mode: when a requested field isn't readable from the page, the agent fabricates it (reported "5 stars" for a rating that lives only in a CSS class). The honest-gap prompt fix (`fix/absent-field-honesty`) made the executor *decline* such fields, but it's a prompt rule — e4b doesn't always obey prompt rules. We need a **safety net that doesn't depend on the executor behaving**: verify answers against the page before accepting them.

Two concrete gaps make this possible with a small change:

1. **The Evaluator is handed the page and ignores it.** `commonCtx` already builds `pageContentBlock` from `lastRead` (`orchestrator.ts:443`) and `evaluate()` passes that ctx in, but `buildEvaluatorMessages` (`prompts/index.ts:133`) never references `ctx.pageContentBlock`. The Evaluator judges from the executor's self-report.
2. **Direct finish skips evaluation entirely.** When the executor calls `finish`, `runUntilTerminal:137` goes straight to `finishOk` — no evaluator, no verification. This is the path the books.toscrape fabrication took.

## Goals

- The Evaluator judges step results **against the actual page content**, not the executor's self-report.
- A `finish(success)` answer is **verified as grounded in what was read** before success is accepted; an unverified answer triggers a bounded self-correction, then downgrades rather than being returned as a clean success.
- Reuse the benchmark's grounding logic (no duplicate hallucination-detection code).

## Non-goals (deferred — YAGNI)

- Multi-vote / self-consistency verification (run the verifier N times, majority rule). Revisit only if single-pass verification proves flaky.
- Per-page multi-source reasoning in the LLM verifier (it verifies against the accumulated read corpus / latest page, not a page-by-page provenance trace).
- Any change to the planner, search, or perception layers.

## Design

Four coordinated pieces, all serving "verify against the page."

### 1. Shared grounding module (reuse, don't duplicate)
Extract the pure grounding functions (`dataNumbers`, `ungroundedNumbers`, and the entity-grounding check) from `tests/bench/scorer.ts` into **`src/agent/verify/grounding.ts`**. The bench scorer imports them from there (behavior unchanged — existing scorer tests still pass). Prod now shares the exact hallucination detector the benchmark scores with.

### 2. Grounding corpus in the orchestrator
The orchestrator keeps only the latest read (`lastRead`). Add a **capped accumulator** (`observedText`, last ~60 KB) that appends every page read this task — the executor's own `READING_TOOLS` results *and* the post-navigation auto-read. This is the corpus the deterministic check grounds the final answer against (the bench already does this in its scripted browser). Reset in `start()` alongside the other per-task state.

### 3. Page-aware Evaluator
`buildEvaluatorMessages` includes `ctx.pageContentBlock` (when present), and the Evaluator system prompt gains a verification rule:
> Verify the executor's claims against CURRENT PAGE CONTENT. If the result asserts a specific fact, number, or rating that is **not present** in the page content, that step has **not** succeeded — verdict FAIL, and name the unsupported claim.

This is additive — existing evaluator tests (which match on "You are the EVALUATOR") are unaffected.

### 4. Verified finish with bounded self-correction
Intercept the executor-initiated finish at `runUntilTerminal:137`. For `verdict === 'success'` only (honest `blocked`/`failed` skip verification):

1. **Deterministic pre-check (fast, free):** `ungroundedNumbers(summary, observedText)`. Any ungrounded number → fail fast (no model call).
2. **Page-aware LLM verify (only if the deterministic check passes):** run the page-aware Evaluator on the finish summary, asking whether every claim is supported by the page. PASS → grounded.
3. **Outcome:**
   - Both clear → `finishOk('success', summary)`.
   - Either fails → **corrective turn:** record the unsupported claim(s) as a corrective note the next executor turn sees ("these claims aren't supported by the page: … — re-read the page, or report them as not available"), increment `verifyAttempts`, and `continue` the loop (same step). The executor gets another turn to re-read / correct / honestly decline.
   - After `verifyAttempts` reaches its cap (default **2**) → `finishOk('partial', summary + "\n\n[unverified against page: <claims>]")`. Never returns an unverified answer as a clean success.

`verifyAttempts` + the existing `maxTurns` bound the loop.

## Data flow

```
executor → finish(success, summary)
   │
   ├─ ungroundedNumbers(summary, observedText)         (deterministic)
   │        ungrounded? ──► corrective turn / downgrade
   │        clean ▼
   ├─ page-aware Evaluator verifies summary vs page    (LLM)
   │        FAIL ──► corrective turn / downgrade
   │        PASS ▼
   └─ finishOk('success')
```

## Error handling

- LLM verify call errors/times out → treat as **inconclusive, accept** (don't trap a finished task behind a flaky verifier); log a warn timeline event so it's visible. The deterministic check still gates numbers regardless.
- Empty corpus (no page ever read, e.g. a pure-search answer) → deterministic check grounds against search output already captured in `observedText`; if truly empty, skip the deterministic step and rely on the LLM verify.
- Corrective note must not blow the scratchpad — cap it like other turn notes.

## Testing / verification

- **Unit:** `grounding.ts` (move the existing `dataNumbers`/`ungroundedNumbers` tests; they must still pass against the new location). A prompt test asserting `buildEvaluatorMessages` includes the page content when `pageContentBlock` is set.
- **Integration (fake model, `orchestrator.test.ts`):**
  - executor finishes with an ungrounded number → gate rejects → corrective turn fires → after the cap, result is `partial` with the annotation.
  - a grounded finish passes straight through as `success`.
  - an honest `blocked` finish skips verification (not downgraded).
- **Benchmark (`npm run bench`, user-run):** `grounded` stays 100% and the `field-absent` honest behavior holds — i.e. verification adds a safety net without breaking the cases that already worked.

## Risks

- **Latency:** one extra Evaluator call per *successful* finish (~20–30 s on e4b), and up to 2 corrective turns when verification fails. Deterministic-first avoids the LLM call when a number is plainly ungrounded. Accepted under the accuracy-over-speed priority, but a real cost.
- **e4b as verifier:** the LLM verify could be lenient. Mitigated by the deterministic number layer and a concrete verification rule ("name the unsupported claim"). If it proves unreliable, the deferred multi-vote pass is the escalation.
