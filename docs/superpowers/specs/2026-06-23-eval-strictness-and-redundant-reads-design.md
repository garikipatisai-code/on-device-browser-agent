# Evaluator strictness + no redundant re-reads

**Date:** 2026-06-23
**Status:** Approved (conversation)

## Problem

Two harness-quality issues observed across three live 5-city comparison runs (neither caused a failure; both are latent quality costs):

1. **Evaluator rationalizes PASS from the wrong item's data.** Its PASS `reason` repeatedly cited *Tokyo's* number when judging the São Paulo / Shanghai steps — it passes a step as long as *some* data exists in the scratchpad, not the **active step's** specific datum. Latent risk: it could PASS a genuinely-failed step.
2. **Redundant re-reads after navigation inflate latency.** The executor wasted whole turns on `tab.wait_loaded` (on an already-loaded tab) and re-extracting pages the harness had **already auto-read**.

## Root causes (verified)

1. Evaluator system prompt (`prompts/index.ts:180`): *"a step is DONE (PASS) if its objective appears **anywhere** [in scratchpad]… FAIL only if its data was **never** gathered."* The 4B reads "anywhere / never" as "any data exists," so another city's number satisfies it. The scratchpad framing (`:195`) reinforces "a step counts as DONE if its data appears here."
2. Executor rules contradict themselves: `:109` says *"after opening a page call `tab.wait_loaded`, then `aria.extract`"*, but the harness **auto-reads after every navigation** (`orchestrator.ts:autoObserveAfterNavigation`, dispatched at `:450`), and `:124`/`:142` already say *"do NOT re-extract a page you have already read."* The model follows `:109` and burns a turn.

Both lines that cause #1 were **deliberately added** to stop replan storms (the evaluator used to mis-FAIL a step whose data was gathered on an earlier turn). The fix must preserve that.

## Principle

Prompt-only, surgical. Keep every protection these lines were added for; change **only** the over-broad part. Mechanical/specific phrasing for the 4B (consistent with [[comparison-anchor-mechanical-prompting]]).

## Component 1 — Evaluator judges the active step's *specific* datum

Reword `:180` and the scratchpad framing `:195`:
- **Keep:** "data gathered on an earlier turn still counts (don't re-fail)"; "fair, not pedantic"; the overshoot/ahead-of-plan PASS rule (`:179`).
- **Add:** the gathered data must be **this step's** specific item. PASS if the datum the ACTIVE STEP was meant to gather appears in the scratchpad/findings/actions; it must match the active step's objective (e.g. for "find São Paulo's population," the scratchpad must contain **São Paulo's** population — do NOT PASS by citing another city's number gathered for a different step). FAIL only if **this** step's specific data was never gathered.
- **Teeth:** the `reason` must name the active step's specific value, so it can't hand-wave with an unrelated item.

No change to the output shape / `parseVerdict` (no truncation-salvage risk). `finishVerdict`, `fact`, the error/empty-page FAIL rule, and the page-grounding rule (`:183`) are untouched.

**Replan-storm guard:** because earlier-gathered data still counts and the bar is "this step's item is present somewhere," a correctly-gathered step still PASSes on a later turn — only the *wrong-item* pass is removed.

## Component 2 — Executor stops redundant re-reads after navigation

Reword `:109`:
- **Replace** "after opening a page call `tab.wait_loaded`, then `aria.extract`" with: *after open_result / tab.open / a click, the new page is **auto-read** for you and appears as CURRENT PAGE CONTENT — do **not** call `tab.wait_loaded` or `aria.extract` again; read from CURRENT PAGE CONTENT.*
- **Preserve** the one legitimate re-extract case (already in `:142`): re-extract only after **you** changed the page in place (filter/sort/expand that didn't navigate).

This aligns `:109` with `:124`/`:142` and the auto-read reality, removing the wasted `tab.wait_loaded`/re-extract turns.

**Not touched (per scope decision):** the every-3-turns periodic evaluator (`orchestrator.ts:313`) stays — it's the stuck-loop / no-progress detector. Eliminating model-call latency beyond the redundant calls is out of scope.

## Explicitly NOT doing

- No output-shape / `parseVerdict` change (keep truncation-salvage intact).
- No code-level eval enforcement (the FINDINGS ledger can't pre-confirm the current step's datum — the fact is captured *after* the eval).
- No eval-cadence change (keeps the stuck-loop safety net).
- The salvage-synthesis prompt (`orchestrator:~864`) old "same basis" wording stays (separate, low-value).

## Testing & validation

- **Unit (content assertions, prompt-only):** evaluator system prompt mentions matching "this step"'s specific item / not another item's; executor rules state the page is auto-read after navigating and to not re-extract / call wait_loaded after a navigation. Full routing matrix + suite stay green.
- **Live proof (user re-run):** (a) re-run the 5-city compare → evaluator PASS reasons name the **correct city per step** (not Tokyo for all), and **no stray `tab.wait_loaded`/re-extract** after opens → fewer turns; (b) a single-page read/extract task → confirm normal reading still works (the legitimate in-place re-extract path intact) and steps still PASS (no replan storm).

## Implementation notes

TDD on the content assertions; branch → ff-merge. Prompt-only edits to `src/agent/prompts/index.ts`. Honest caveat: #2 trims wasted turns, not the inherent 4B per-call floor — expect a modest latency drop, not a halving. Both changes' real proof is the live re-run.
