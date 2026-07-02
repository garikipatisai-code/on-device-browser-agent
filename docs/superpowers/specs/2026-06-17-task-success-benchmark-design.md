# Task-Success Benchmark — Design

- **Date:** 2026-06-17
- **Status:** Approved (proceeding under the user's "continue to completion" directive)
- **Theme:** C (Measurement) — first cycle of the app-perfection roadmap.
- **Branch:** `feat/task-success-benchmark`

## Purpose

Give the agent an **end-to-end task-success metric** so that future accuracy work
(Theme A: verification & grounding) is *proven*, not assumed. Today only tool-call
reliability is measured (`extension/scripts/measure_toolcalls.mjs`), which saturated
at 100% for both `gemma4:e4b` and `gemma4:26b` — it cannot tell us whether the agent
actually **completes real multi-step tasks correctly**. (This is the lesson from the
26b evaluation: without an end-to-end ruler, "better" is unprovable.)

## What "done" means (this cycle)

- A runnable benchmark that drives the **real** planner→executor→evaluator loop against
  the **real** local model, over a small set of scripted multi-page task fixtures, and
  prints a per-dimension report (`completed` / `correct` / `grounded` %) plus overall,
  across N trials per task.
- The **deterministic core** (scorer + scripted-browser + fixtures) is unit-tested and
  runs in `npm test` with **no model**.
- The **live runner** is env-gated (`OLLAMA_BENCH=1 npm run bench`) so normal CI never
  hits Ollama. The user runs it (the dev sandbox cannot reach the Ollama socket).

## Architecture — three components

### 1. Scripted browser (`FixtureRegistry`)
A `ToolRegistry` whose browser tools are backed by fixture data, not Chrome/CDP. It
holds a per-tab "current page state". Behaviour:
- `aria.extract` → returns the current page's pre-indexed ARIA text (written in the
  exact `serializeTree` format: `[n] role "name"` lines + indented text), so the model
  sees what real `aria.extract` produces.
- `search` → returns the fixture's canned results and populates the same
  `getLastSearchResults()` grounding the real `open_result`/`tab.open` rely on.
- `tab.open(url)` / `open_result(index)` / `tab.click(index)` / `tab.type({submit})` →
  advance the fixture's small state machine to the next page (see Transitions).
- `finish` / `next_step` / `memory.*` → behave like the real tools.

This exercises the **real** orchestrator scaffolding (observe-then-act gate,
carry-forward CURRENT PAGE CONTENT, auto-re-extract after navigation, circuit breaker,
evaluator cadence) against deterministic pages.

### 2. Runner
Builds a real `OllamaClient` (localhost), a `FixtureRegistry` per task, runs
`Orchestrator.runUntilTerminal`, captures `{verdict, summary, turns, replans, trace}`,
repeats N trials, hands results to the scorer, prints the report. Reuses the
`chrome.storage` stub from `extension/tests/setup.ts` so `state_store` works under
Node/vitest.

### 3. Scorer (pure, deterministic)
Given a task's `expect` block and a run's `{verdict, summary}` + the scripted page
texts, returns per-dimension booleans. No model calls; identical output every run.

## Fixture schema

Concrete example (canonical shopping task):

```ts
{
  id: 'shop-mouse-detail',
  goal: 'go to shop.example, search for "wireless mouse", open the first product, and report its title, price, and rating',
  pages: {
    home:    { url: 'https://shop.example/',            aria: `[1] searchbox "Search"\n[2] button "Go"` },
    results: { url: 'https://shop.example/s?k=wireless+mouse',
               aria: `[1] link "Logitech M185 Wireless Mouse"\n   text "$13.42"\n[2] link "Anker Mouse"\n   text "$19.99"` },
    product: { url: 'https://shop.example/dp/M185',
               aria: `   heading "Logitech M185 Wireless Mouse"\n   text "$13.42"\n   text "4.6 out of 5 stars"` },
  },
  start: 'home',                       // first tab.open of a matching host lands here
  transitions: [
    { from: 'home',    when: { tool: 'tab.type',  submit: true }, to: 'results' },
    { from: 'results', when: { tool: 'tab.click',  index: 1 },    to: 'product' },
  ],
  expect: {
    verdict: 'success',
    mustContain: ['Logitech M185', /\$13\.42/, /4\.6/],
    grounding: ['product'],            // numbers/entities in the answer must appear in these pages
  },
}
```

Notes:
- `tab.open(url)` resolves to the page whose `url` host+path matches; an **unknown URL**
  resolves to a 404-ish empty page (lets us test graceful failure).
- Transitions are a tiny per-fixture state machine keyed on `(current state, tool, arg)`.
- `mustContain` entries are `string | RegExp`; an array under an `orderedList` key (for
  ranked tasks) additionally checks order of appearance.

## Scoring dimensions (per task, aggregated across trials)

- **completed** — finished with `verdict: 'success'` (not abort / loop / max-turns).
- **correct** — every `mustContain` assertion matches `finish.summary`.
- **grounded** — every numeric token (prices, ratings, counts) **and** each declared key
  entity in `finish.summary` appears in the concatenated text of the `grounding` pages.
  An ungrounded number = a hallucinated fact → grounding **FAIL**. *This is the headline
  accuracy signal and the metric Theme A must move.*
- **efficiency** (secondary, reported not gated) — turns, replans.

**Report** (mirrors `measure_toolcalls.mjs` style): per-task line + totals —
`completed X% · correct Y% · grounded Z%` over `tasks × trials` runs, plus mean turns.
Trials absorb the model's `temp=1.0` sampling variance; app-default sampling is **kept**
(not forced to `temp 0`) so the number reflects real behaviour.

## Seed task set (v1 — 5 tasks)

1. **shop-detail** — site search → open first product → report title/price/rating. (canonical multi-page)
2. **search-list** — web search → list top 3 results with titles. (search-and-list)
3. **rank-extract** — results page with 5 products → report the 3 cheapest in price order. (ranked correctness + numeric grounding)
4. **empty-honesty** — search/landing returns "no results"/404 → agent must report `blocked`/`failed` and must **not** invent an answer. (anti-hallucination test; both `correct` and `grounded` hinge on honesty)
5. **job-apply** — application form + `profileJson` → fill fields → submit → confirm. (form-fill flow)

## File layout

- `extension/tests/bench/fixtures.ts` — fixture type + the 5 seed fixtures.
- `extension/tests/bench/scripted_browser.ts` — `FixtureRegistry` (scripted browser).
- `extension/tests/bench/scorer.ts` — pure scorer (completed / correct / grounded).
- `extension/tests/bench/scorer.test.ts` — unit tests for scorer + scripted registry (run in `npm test`, no model).
- `extension/tests/bench/run.ts` — live runner (real Ollama, env-gated) + report printer.
- `extension/package.json` — add `"bench"` script (exact runner mechanism — `vite-node` vs `vitest run` — settled in the implementation plan).

## Testing strategy

- **TDD the deterministic core** (`scorer.ts`, `scripted_browser.ts`): write
  `scorer.test.ts` first — grounding catches a planted hallucinated price; assertion
  matching handles regex + ordered lists; the scripted registry advances state correctly
  on tool calls. These run in normal `npm test`.
- The **live runner** is validated by the user running `npm run bench` against the real
  model; it is gated out of CI.

## Out of scope (future)

- LLM-judge / fuzzy answer scoring (revisit only if free-text tasks need it).
- Entity grounding beyond declared key entities (v1 grounds numbers + declared entities).
- Real-Chrome + frozen-snapshot fidelity — that is the **Theme B** benchmark; this one
  deliberately targets the reasoning/verification layer.

## How this feeds the roadmap

Once green, this benchmark is the ruler for **Theme A** (verification & grounding):
record a baseline, implement the fixes (evaluator sees the page; `finish` verified
against page text; cheap second-opinion pass), and prove `grounded` / `correct` % rise.
