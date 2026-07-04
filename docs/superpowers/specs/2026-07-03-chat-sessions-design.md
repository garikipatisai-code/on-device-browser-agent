# Chat-based sessions + session context (backend)

**Date:** 2026-07-03
**Status:** Approved (conversation)

## Problem

Today one goal = one ephemeral run: `Orchestrator.start(goal)` resets `facts`/`observedText`/`taskId` to empty on every call, and IndexedDB stores (`findings`, `events`, `scratchpad`) are keyed by `taskId` with nothing linking multiple `taskId`s together. There is no way to send a follow-up message that continues using what a prior run already established ("now check a different site too", "what was the price again?") — every goal starts from zero. The user wants GPT-style chat sessions: a history of past conversations, and true multi-turn continuation within one, without risking GPU overload and while making real use of `gemma4:e4b`'s 128K context ceiling.

This is backend-scoped by explicit choice: session/turn data model, context-carry logic, and the `PanelCommand` entry points the side panel needs to drive it. A dedicated chat-thread UI (message bubbles, session switcher) is a separate follow-up spec.

## Principle

Evolutionary, matching this repo's established pattern for both prior framework specs: a **session** is a thin new layer *on top of* today's run — it does not change how a single run (now called a **turn**) works internally. A turn keeps its own `taskId`, its own `observedText`/scratchpad/plan, exactly as today. What's new is: (1) a `Session` record grouping an ordered list of turn IDs, (2) a small carried-forward `SessionContext` (the facts ledger + last summary) that seeds the next turn's `Orchestrator.start()` instead of starting empty, and (3) `PanelCommand` entry points to create/list/select/delete a session.

## Design

### Data model (new IndexedDB stores, `state_store.ts`)

```ts
export interface Session {
  id: string;            // ulid
  title: string;          // first turn's goal text, truncated to ~80 chars
  createdAt: number;
  lastActiveAt: number;
  turnIds: string[];      // ordered taskIds, one per turn run in this session
}

export interface SessionContext {
  sessionId: string;       // primary key
  facts: Fact[];           // carried-forward grounded facts ledger (same Fact type as today)
  lastSummary: string;     // "<verdict>: <summary>" from the most recent finished turn, capped
  updatedAt: number;
}
```

Two new object stores added to the existing `db()` upgrade in `state_store.ts`, bumping `DB_VERSION` 1→2 (empty for existing installs — `upgrade()` only adds stores, never touches existing ones, so no migration code is needed): `sessions` (keyPath `id`) and `sessionContext` (keyPath `sessionId`).

A turn is exactly today's `Orchestrator` run — one `taskId`, its own `observedText`/scratchpad/plan/circuit-breaker state, all reset at `start()` exactly as now. Nothing about turn-internal behavior changes. A session's `turnIds` is the transcript; each turn's own existing timeline/events already serve as that turn's detail view — no new "message" data structure.

**Backward compatible for free:** a hot state or run with no active session behaves byte-identical to today (see Testing) — sessions are additive, not a replacement for the existing single-run model.

### Context injection into a turn

`CommonContext` (`agent/prompts/index.ts`) gains one new optional field, rendered the same way `findingsBlock`/`preferences` already are — an optional prompt section, filtered out when absent:

```ts
export interface CommonContext {
  // ...existing fields unchanged...
  priorSummary?: string;  // new
}
```

```ts
// agent/prompts/index.ts — new helper, same shape as the existing preferencesBlock
function priorSummaryBlock(summary?: string): string {
  const s = (summary ?? '').trim();
  if (!s) return '';
  return `PRIOR TURN IN THIS SESSION (for continuity — the current GOAL may reference "it", "that", "the same site", etc.):\n${s}`;
}
```

Added to `buildPlannerMessages`'s `user` array (right after `steerBlock`, since both are "context that reframes the goal") and to `buildEvaluatorMessages` the same way.

`Orchestrator.start(goal)` today unconditionally does `this.facts = []`. Changed to:

```ts
async start(goal: string, sessionId?: string | null): Promise<AgentStateHot> {
  // ...unchanged resets...
  this.sessionId = sessionId ?? null;
  const carried = this.sessionId ? await loadSessionContext(this.sessionId) : null;
  this.facts = carried?.facts ?? [];
  this.priorSummary = carried?.lastSummary ?? '';
  if (this.sessionId) await setSessionTitleIfBlank(this.sessionId, trimmed);
  // ...rest unchanged...
}
```

`sessionId` accepts `string | null | undefined` (not just `string`) so a caller with no active session — including every existing call site and test that doesn't pass a third argument at all — behaves identically to today: `this.sessionId` stays `null`, `carried` stays `null`, `facts`/`priorSummary` start empty exactly as before. This is the byte-identical baseline (see Testing) — **`agent.start` does not auto-create a session.** A turn only carries context forward when a session was explicitly created/selected first (`session.new`/`session.select`); wiring the panel UI to actually do that by default is left to the follow-up UI spec. `setSessionTitleIfBlank` sets `Session.title` to the (truncated) goal text the first time a session's first turn starts — a no-op on every later turn in that session, once `title` is already non-empty.

`commonCtx()` passes `priorSummary: this.priorSummary` into the object it already builds for `findingsBlock`. No change to `facts.ts` itself — a carried-forward fact is validated exactly the same way a same-turn fact is (it was already grounded at admission time in a prior turn; the ledger's trust model doesn't distinguish "grounded this turn" from "grounded last turn", it's already timeless by design).

After a turn reaches a terminal state (`finishOk`/`abort`), if `this.sessionId` is set: append `this.taskId` to that session's `turnIds`, write `{facts: this.facts, lastSummary: <capped verdict+summary>}` to `sessionContext`, and bump `lastActiveAt`. `lastSummary` is capped at 500 chars (finish summaries are already short prose; this guards the pathological case, mirroring `renderFacts`'s existing `maxChars` pattern).

### GPU safety — the "hot slot" falls out of the existing design

`background/index.ts` holds exactly one `_orch` at a time (the `if (_orch || _starting)` guard in `handleStart` already rejects a second concurrent run). This means there is structurally only ever one turn's context resident in memory or loaded into Ollama regardless of how many sessions exist in IndexedDB — an idle session costs zero VRAM; only the active turn's assembled prompt ever reaches the model. Switching sessions is just: next `agent.start` reads a different `sessionId`'s `SessionContext` instead of the previous one. `keep_alive` stays the existing `'10m'` constant on every `OllamaClient.chatOnce` call — switching sessions never forces an unload/reload of the model itself, only what's injected into the next prompt.

The one new, real bound: does carried context grow unboundedly across many turns in one long session? No — `Fact[]` is already capped at ≤24 entries (`addGroundedFact`'s existing `max` param, oldest-evicted) and `renderFacts` already caps at 4,000 chars; carrying forward the *same* already-capped array turn-to-turn adds no new growth vector. `lastSummary`'s new 500-char cap is the only new bound needed.

`numCtx` (Settings, already user-controlled, already scales `budgetsFor`/`capsFor`) is untouched by this spec — carried facts/summary are small (capped, as above) relative to a single page read (12,000 chars), so they don't materially compete with `numCtx` headroom the way raw page content does. Raising `numCtx` toward the 128K ceiling already widens per-role budgets today; this spec doesn't need a new budget dimension on top of that.

### New entry points

```ts
// shared/messages.ts — PanelCommand additions
| { type: 'session.new' }
| { type: 'session.list' }
| { type: 'session.select'; sessionId: string }
| { type: 'session.delete'; sessionId: string }

// shared/messages.ts — SwUpdate addition
| { type: 'sessions'; sessions: Session[]; activeSessionId: string | null }
```

`agent.start` itself is **unchanged** in shape (`{type:'agent.start', goal}`) — it implicitly targets whichever session is currently active, or no session at all if none has been created/selected (see previous section — no auto-create). `background/index.ts` holds one new module-level `_activeSessionId: string | null = null`, set by `session.select`/`session.new`, read by `handleStart` and passed as `_orch.start(goal, _activeSessionId)`. `session.new` creates a `Session` record (`title: ''`, empty `turnIds`) and sets it active; `session.select` sets `_activeSessionId` (rejected if a turn is currently running, same guard shape as `agent.start`'s `if (_orch)` check); `session.delete` removes the `Session` + its `SessionContext` (turn-level `events`/`findings`/`scratchpad` records are left as historical detail, same as they already outlive a single run today — deleting a session doesn't need to cascade-delete turn data for this spec).

`session.list` broadcasts every `Session`, sorted by `lastActiveAt` descending — the "recent chats" list a GPT-style UI would render, once the follow-up UI spec consumes it.

## Trade-off

Carrying facts forward means a session's later turns can be grounded in something read in an *earlier* turn, not just the current one — this is the intended behavior (that's what "continuation" means), not a new privacy or safety exposure. Nothing about domain tiers or the circuit breaker changes; those are per-turn concerns already, untouched by this spec.

Redaction *does* need one addition beyond what already exists, caught during implementation review: this is the first data in this codebase that persists to IndexedDB across independent runs rather than living only in one run's memory for one run's duration, so `saveSessionContext` redacts `facts`/`lastSummary` before the write — the same `redact`/`redactDeep` boundary every other disk write in `orchestrator.ts` already respects (findings, scratchpad notes, timeline events), applied here for the first time to something that outlives a single turn.

## Explicitly NOT doing

- Live tabs persisting across turns — a follow-up turn re-opens what it needs fresh; only *knowledge* (facts/summary) carries over.
- Chat-thread UI, session switcher UI, message bubbles — a separate follow-up spec builds these against the entry points defined here.
- Auto-detecting VRAM or auto-tuning `numCtx` — no reliable cross-platform VRAM-detection API exists for a Chrome extension talking to a local Ollama server; `numCtx` stays the existing user-controlled Settings value.
- Cross-session knowledge sharing — session B never sees session A's facts, matching how chat threads normally work.
- Editing or branching past turns ("regenerate from turn 3") — linear continuation only, one active turn per session at a time.
- Cascade-deleting a turn's `events`/`findings`/`scratchpad` when its session is deleted — left as-is, matching how that data already outlives a single run today.

## Testing (TDD)

- `state_store.ts`: create/list/select/delete a session; save/load `SessionContext`; a `Session` with no `SessionContext` yet loads as `facts: [], lastSummary: ''` (a brand-new session's first turn).
- `prompts/index.ts`: `priorSummaryBlock` renders when non-empty, omitted (empty string, filtered by the caller) when absent — same convention as `preferencesBlock`.
- Orchestrator integration test: turn 1 (in a session) establishes a grounded fact; turn 2 in the *same* session references that fact and grounds successfully **with no re-observation of the original page** — proving the carry-forward actually reaches the prompt and the grounding corpus, not just that it's stored.
- Explicit regression test: a turn started with no `sessionId` (today's `agent.start` behavior, and `agent.askPage`'s seeded-plan path) behaves byte-identical to the pre-session baseline — reuse existing `scripted_e2e.test.ts` fixtures/assertions unchanged as the proof, matching both prior framework specs' own regression-test pattern.
- `DB_VERSION` bump: a test opening the DB fresh (no prior `sessions`/`sessionContext` stores) succeeds and both new stores exist afterward.

## Implementation notes

Touches: `state_store.ts` (two new stores + CRUD functions, `DB_VERSION` bump), `agent/orchestrator.ts` (`start()` gains an optional `sessionId` param, `priorSummary` field, terminal-state write-back), `agent/prompts/index.ts` (`CommonContext.priorSummary` + `priorSummaryBlock`, wired into `buildPlannerMessages`/`buildEvaluatorMessages`), `shared/messages.ts` (`PanelCommand`/`SwUpdate` additions), `background/index.ts` (`_activeSessionId` + four new `case` branches in the port's `onMessage` switch, `handleStart` passes it through). No changes to `agent/framework/`, `agent/safety/`, `agent/tools/`, or any `roles/*.ts` file's own logic — this is additive at the orchestrator/prompt boundary only, same shape as how the prior tiering work was additive at the provider boundary.
