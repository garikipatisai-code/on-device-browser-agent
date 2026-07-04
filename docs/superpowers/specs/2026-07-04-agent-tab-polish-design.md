# Agent tab polish: bottom-anchored chat layout + fast-path for non-actionable input

**Date:** 2026-07-04
**Status:** Approved (conversation)

## Problem

Manual testing of the just-shipped chat-sessions frontend (see `docs/superpowers/specs/2026-07-04-chat-sessions-frontend-design.md`) surfaced two real issues:

1. **Layout.** The Agent tab's composer sits at the top of the panel, with everything else (transcript, results, activity) stacking below it in normal document flow — the whole panel scrolls as one page. Frontier chat UIs (ChatGPT, etc.) pin the input at the bottom with a scrolling message pane above it; that's what a "GPT-style chat" should feel like, and it's what this spec's own screenshot reference shows.
2. **Latency/behavior on non-actionable input.** Typing something like "Hi" — completely reasonable in a chat UI — sends it through the full Planner → Executor → Evaluator loop as if it were a real browser task. Observed: 101 seconds total (43s Planner, three 13-27s Executor turns, 4s Evaluator) before the run ends as `blocked`. Traced the root cause directly in code: the Planner has no fast-path for non-actionable input, so it fabricates a fake one-step "plan" whose step is really a refusal in prose ("Since no goal was provided..."). Nothing validates that a step describes an action, so it's dispatched to the Executor, which calls `echo` (a content-only tool — it never sets `finish`/`advanceStep`/`fatal`), so the loop just re-invokes the Executor on the same step. The "stop after 3 tries" visible in the log is a **prompt-only instruction to the model**, not code-enforced; what actually routes to the Evaluator is an unrelated global `turn % 3 === 0` periodic-evaluation check. The Evaluator then fails it and the run ends `blocked`.

Confirmed this is architecturally safe to fix without touching grounding/anti-hallucination machinery: `gateFinishSummary` (`agent/framework/sous_chef.ts`) only runs its grounding check for `'success'`/`'partial'` verdicts — a `'blocked'` verdict already skips it entirely, both today and in the fix below.

## Part A: Bottom-anchored chat layout

### Design

The Agent tab's markup splits into three stacked regions inside a fixed-height flex column (today the whole page grows and the browser/panel scrolls it like a webpage — that changes to `.app` filling the viewport with `display:flex; flex-direction:column; height:100%` and its children managing their own scroll):

1. **Fixed header** — `ConnectionCard` (if Ollama is down) + `SessionSwitcher`. Always visible regardless of scroll position, so the active chat's identity never scrolls out of view.
2. **Scrolling middle** — the `notice` `Alert`, `Transcript` (past turns), the active turn's `RunState`/`ResultCard`/`Timeline`, and the empty state. This region alone gets `flex: 1; min-height: 0; overflow-y: auto` — everything that can grow arbitrarily long lives here, scrolling independently of the header/footer.
3. **Fixed footer** — `Composer`, pinned to the bottom via `flex-shrink: 0`, always reachable without scrolling.

**Auto-scroll to latest**: whenever the transcript/active-turn content changes (a new turn starts, an event streams in, a turn finishes), the scrolling middle region scrolls to its bottom automatically — matching ordinary chat-app behavior, so the user never has to manually scroll down to see what's happening while typing in the pinned-bottom composer.

**Scope**: this restructuring applies only to the Agent tab's internal markup and a handful of new CSS rules. Settings/Recipes/Metrics tabs, `Brand`, `Tabs`, and the top-level `connectionLost` banner are untouched — they keep their current normal-flow behavior. No component's props or logic change; this is a pure layout/CSS reorganization of `App.tsx`'s JSX structure for the `tab === 'agent'` branch plus new `styles.css` rules.

## Part B: Fast-path for non-actionable input

Two independent layers, combined:

### B1 — Instant reply for obvious chitchat (heuristic, no Planner/Executor/Evaluator at all)

A small, deliberately narrow, case-insensitive exact-match list — not a broad "short message" rule, since that would misclassify real short goals like "buy milk" or "check gmail". Match after trimming whitespace and any single trailing punctuation mark (`.`, `!`, `?`), against exactly this list:

```
hi, hello, hey, hiya, yo, hello there, hey there,
good morning, good afternoon, good evening,
test, thanks, thank you, ok, okay
```

Checked in `background/index.ts`'s `agent.start` handler, before the existing session auto-create logic runs.

On a match: skip session creation entirely (this is a quick aside, not a chat turn — same posture as `agent.askPage`'s existing sessionless-by-default behavior) and skip the `Orchestrator` entirely. Instead, make one lightweight, non-tool-calling chat completion (a small dedicated prompt — NOT the Planner/Executor/Evaluator prompts, which are shaped for goal-decomposition and tool-calling and would be the wrong tool for a friendly reply) using an already-configured model (the executor model, reused — no new Settings field), and broadcast the result as a single `finish` `TimelineEvent` with `verdict: 'chat'`.

This requires **zero frontend changes** — `App.tsx`'s existing `handleStart` already clears `events` client-side before sending, and the existing `latestFinish(events)`/`ResultCard` path already renders any `finish` event that arrives, regardless of verdict. `describeVerdict`'s existing default branch (unknown verdict → capitalized label, `mute` tone) already renders `'chat'` reasonably as "Chat" with a neutral badge — no changes needed there either.

If the lightweight chat completion itself fails (Ollama down, etc.), fall back to a static canned reply ("Hi! Tell me what you'd like me to do — e.g. \"find the cheapest flight to NYC\".") rather than surfacing an error for what's supposed to be the fastest, most forgiving path in the app.

New code lives in a new small file, `background/quick_chat.ts` (detection function + the lightweight completion + the fallback), keeping this self-contained rather than growing the already-large `background/index.ts` further.

### B2 — Structural fix for anything the heuristic misses (covers every other non-actionable input, not just greetings)

The heuristic in B1 only catches an explicit list — real robustness comes from fixing the actual loop bug so ANY input the Planner itself recognizes as non-actionable resolves fast, not just the ones on a hardcoded list.

Change the Planner's contract: its prompt gains an explicit instruction that when GOAL doesn't describe an actionable task, it should return an empty `steps: []` array instead of inventing a step that just asks for a goal (reusing the existing plan JSON schema — no new field needed). In `orchestrator.ts`, immediately after the Planner call returns (in `plan()`, before the resulting `Plan` is applied and before entering the Executor/Evaluator loop at all), check for a zero-length steps array and short-circuit straight to a `blocked` finish — mirroring the existing `finishOk`/`abortNow` pattern, with a summary like "I need a clearer goal to work with — could you tell me what you'd like me to do?" This is the same "skip machinery that can't help" idea `agent.askPage`'s seeded-plan already uses, applied at the other end (skip straight to finish, instead of skip straight to a pre-built plan).

This fix benefits every non-actionable-input case, not just what B1's list catches — cost drops from 101s (full loop) to one Planner call (~30-45s, the Planner being this codebase's slowest role already), with zero Executor/Evaluator round-trips wasted on a step that was never going to succeed.

**Scope check on `steps: []` safety**: `plan.ts`'s `newPlan`/`currentStep`/`walkPlan` and the rest of the run loop have never had to handle a zero-step plan before (every existing code path assumes at least one step). Rather than making that machinery newly tolerant of an empty plan, the short-circuit happens BEFORE a `Plan` is ever constructed or handed to `applyPlan`/`currentStep` — so nothing downstream needs to change or be made empty-plan-safe. The implementation plan should verify the exact call site in `plan()`/`runUntilTerminal()` where this check cleanly intercepts before any current-step-dependent code runs.

## Explicitly NOT doing

- No changes to `agent.askPage` — it already bypasses the Planner via its own seeded plan; chitchat typed into "Ask about this page" is out of scope for this pass.
- No new Settings field for a dedicated "chat model" — B1 reuses the already-configured executor model.
- No broader heuristic (e.g. word-count-based) for detecting chitchat — the explicit list is deliberately conservative to avoid misclassifying short real goals.
- No changes to grounding/anti-hallucination verification (`verifyFinish`/`gateFinishSummary`) — confirmed both fixes stay entirely on the `blocked`/`chat` verdict paths that already skip that machinery.
- No changes to Settings/Recipes/Metrics tab layout.

## Testing

- **Layout**: no new automated test (matches this codebase's existing convention — `App.tsx`/layout has never had dedicated test coverage; verified via manual browser check, same as the chat-sessions frontend cycle's own precedent).
- **B1**: unit test for the chitchat-detection function (matches list → true, real goals like "find the cheapest flight to NYC" → false); a `background_run_lifecycle.test.ts`-style test confirming `agent.start` with a matching message never creates a session and never invokes the orchestrator factory, broadcasting a `finish`/`chat` event instead.
- **B2**: orchestrator integration test with a fake Planner response of `{"steps": []}`, asserting the run finishes as `blocked` immediately with zero Executor/Evaluator calls made (extending the existing fake-Ollama test patterns already used throughout `tests/integration/orchestrator.test.ts`).

## Implementation notes

Touches: `sidepanel/App.tsx` (Agent tab JSX restructuring into 3 regions), `sidepanel/styles.css` (new layout rules + auto-scroll wiring), `background/index.ts` (`agent.start` handler gains the B1 chitchat check before session auto-create), `background/quick_chat.ts` (new — detection + lightweight completion + fallback), `agent/prompts/index.ts` (Planner prompt gains the "return empty steps for non-actionable input" instruction), `agent/orchestrator.ts` (`plan()`/its call site gains the zero-steps short-circuit to `blocked`).
