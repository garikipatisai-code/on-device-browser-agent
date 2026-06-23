# Planner: recipe-parity retry + criterion quality

**Date:** 2026-06-23
**Status:** Approved (conversation)

## Problem

For a recipe-matched task the planner sometimes emits a single, mis-scoped step, which cascades into evaluator confusion and a stalled run. Live evidence — goal *"On the British Museum's website, what visitor facilities does it list — cloakroom, café, Wi-Fi?"*:

- Matched `seed-contact` (a **3-step** recipe: open official source → report only fields present → never invent).
- Planner produced **1 step**: *"Search for the British Museum's official website,"* with success criterion *"a search-results page is displayed."*
- The criterion describes the *first action*, not the task. As the agent opened the page and read it, the evaluator couldn't reconcile "is a search-results page displayed?" with reality → **garbled, self-contradicting verdicts** (30–40s essays that argue to PASS then return FAIL) → scroll loop → circuit breaker → **partial**.

## Root cause (verified)

A decompose retry already exists (`planner.ts:87`) and fires at `steps.length === 1 && workflowRecipe` — so it *did* trigger here. But it is broken for non-comparison recipes in two ways:

1. **It drops the recipe on retry** (`planner.ts:89` calls `buildPlannerMessages(ctx, replanContext)` with no recipe), losing seed-contact's 3-step structure.
2. **Its nudge is comparison-specific** (*"break into 3–5 steps, one per city or product"*). For a single-page extraction task the 4B reads that, concludes "not a multi-item task," returns 1 step again → not adopted (`s2.length > steps.length` is false) → the bad 1-step plan survives.

Separately, the first plan's **success criteria describe the action, not completion**, which is what confuses the evaluator.

The e12a444 prompt fix ("turn each recipe step into a plan step") didn't prevent the collapse — prompt instruction alone isn't reliably obeyed by a 4B; a deterministic harness guard is needed.

## Principle

Keep the planner (it can expand a "for each item" recipe step into one step per named item — that's what makes comparison work). Make the **harness deterministically detect an under-planned recipe task and retry productively**, keeping the recipe and using a generic nudge. Lean on the prompt only for criterion *wording*.

## Design

### Component 1 — recipe-parity retry (`planner.ts` + `orchestrator.ts`)

- `PlannerInput` gains `recipeStepCount?: number`. The orchestrator passes `this.matchedWorkflow?.steps.length` at both `runPlanner` call sites (plan + replan).
- Replace the current `if (steps.length === 1 && input.workflowRecipe)` block with:
  `if (input.workflowRecipe && input.recipeStepCount && steps.length < input.recipeStepCount)`.
  A good plan for a "for each item" recipe has **more** steps than the recipe (one per item), so `steps.length < recipeStepCount` is a clean "collapsed" signal.
- The retry **keeps the recipe** (`buildPlannerMessages(ctx, replanContext, workflowRecipe)`) and uses a **generic** nudge:
  > *Your plan has {n} steps but the recipe lists {m}. Produce ONE plan step per recipe step, in order — and expand any "for each item" step into one step per named item in the goal. Each step's successCriteria must state what is TRUE when that step is done (e.g. "the page shows the museum's facilities"), not the action taken. Respond with ONLY {"steps":[…]}.*
- **Adopt only if richer** (`s2.length > steps.length`) — unchanged safety, so the retry can never make the plan worse or empty.

### Component 2 — criterion quality (`prompts/index.ts`, `buildPlannerMessages`)

Add one clause so the *first* plan's criteria are sound (not just the retry's):
> *Each step's successCriteria states what will be TRUE when the step is done (e.g. "the museum's facilities are listed on the page"), not the action performed.*

## Failure mode → guardrail

| Failure mode (observed) | Guardrail |
|---|---|
| recipe task planned as 1 mis-scoped step | deterministic parity retry: plan steps < recipe steps → retry |
| retry drops the recipe, loses its structure | retry now **keeps** the recipe |
| comparison-only nudge doesn't fit other recipes | generic nudge: "one step per recipe step; expand for-each-item per named item" |
| criterion describes the action, confusing the evaluator | criterion-quality clause (main prompt + retry nudge) |
| retry could worsen/empty the plan | adopt only if `s2.length > steps.length` |

## Explicitly NOT doing

- **Not** deterministically seeding the plan from the recipe (Approach B) — too rigid for "for each item" recipes (can't expand per-instance).
- **Not** firing the parity retry for non-recipe tasks (they keep only the existing 0-step retry).
- **Not** changing the eval cadence or evaluator logic — the evaluator confusion is downstream of the bad plan; a correct plan with matching criteria should resolve most of it. (If it persists, separate task.)

## Testing (TDD)

- `runPlanner` (mock ollama): first call returns a 1-step plan, retry returns a 3-step plan, `recipeStepCount=3` → final plan has 3 steps (parity retry fired + adopted). A plan with `steps.length >= recipeStepCount` → no retry (one model call). Retry that returns ≤ original count → original kept.
- `buildPlannerMessages` content assertion: contains the criterion-quality clause ("TRUE when the step is done"/"not the action").
- Full suite + tsc + build green.
- Live proof: re-run the British Museum facilities goal → plan is ~3 steps with task-matching criteria; evaluator verdicts are clean; a real facilities answer (or honest "not listed" per field).

## Honest caveat

Still probabilistic: if the 4B refuses to decompose even on the recipe-keeping retry, the "adopt only if richer" guard leaves the original thin plan — same as today, never worse. The deterministic trigger + keeping the recipe + generic nudge substantially raise reliability over the current comparison-only retry, but don't guarantee it every sample.

## Implementation notes

Prompt + light harness logic; no new tools/models. Files: `src/agent/roles/planner.ts`, `src/agent/orchestrator.ts` (2 call sites), `src/agent/prompts/index.ts`, plus planner + prompt tests. TDD; branch → ff-merge.
