# Prod-readiness fixes from the 2026-07-01 full-repo review

**Date:** 2026-07-01
**Status:** Approved (goal: "fix everything and re-review... until prod ready")

## Problem

A full-repo honest review (6 parallel subsystem audits + direct verification) found 5 real correctness/security gaps, several dead-code items, and a few doc-drift items. None are systemic; all are independently fixable. This spec covers the items that involve an actual design decision. Pure deletions and doc-text fixes are covered directly in the plan with no design section needed.

## Fixes with a design decision

### 1. PII leak via `emit()` → IndexedDB (`orchestrator.ts:440`, `:950-953`)

**Root cause:** `emit()` persists every `TimelineEvent` verbatim via `appendEvent()`. The `tool.call` variant carries raw tool `args` (can contain typed PII). Two prior fixes (`f1710e1`, `a1e12d4`) redacted the scratchpad and the facts ledger but not this path — each fix patched the specific call site a scenario hunt found, not the shared chokepoint.

**Design:** redact centrally, once, inside `emit()` itself rather than at each call site — so no future `TimelineEvent` variant can reintroduce this bug. `redact()` (`safety/redact.ts`) already takes a string; add a small `redactEvent(ev: TimelineEvent): TimelineEvent` that redacts known string-bearing fields (`args` via `JSON.stringify`→redact→`JSON.parse`, `content`, `message`) and pass every event through it inside `emit()`. The existing per-call-site `redact()` on `tool.result.content` becomes redundant but harmless (double-redaction of already-clean text is a no-op) — remove it once the central version is in to avoid two sources of truth.

**Why not fixed differently:** redacting only at the `tool.call` site (mirroring `tool.result`) would fix today's known gap but repeat the same reactive pattern that missed it twice already. Centralizing in `emit()` is the same line count, closes the whole class.

### 2. Auto-learned recipes have no quarantine (`workflow_memory.ts:636`)

**Root cause:** `quarantineWorkflow` explicitly early-returns for any id not prefixed `user:`. Auto-learned recipes get matched/replayed with no post-failure penalty.

**Design:** generalize `quarantineWorkflow` to accept `origin: 'user' | 'auto'` recipes. For `user:` recipes, behavior is unchanged (rollback to `lastGood` if present, else delete). For `auto:` recipes, there is no `lastGood` concept (auto recipes aren't hand-edited), so a failed run always deletes the auto recipe outright — an auto-learned recipe gets exactly one chance; if the run that used it fails, it's gone. This is stricter than the user path by design: a user recipe survives a bad edit via rollback because a human invested effort in it; an auto recipe is free to re-learn from a future clean run, so deleting it on first failure is the correct (and simplest) policy, not a compromise.

**Why not fixed differently:** giving auto recipes a `lastGood`/rollback path like user recipes would require snapshotting on every promotion, more state for a recipe nobody curated. Delete-on-failure is simpler and matches "auto is a fallback, not curated."

### 3. Mid-run service-worker death is invisible to the UI (`port.ts`, `App.tsx`, `background/index.ts`)

**Root cause:** `PortClient` exposes no disconnect callback; `App.tsx` never learns the SW died mid-run. Separately, `background/index.ts`'s crash-resume logs "marking ABORTED" but `clearHot()` just deletes state to bare IDLE.

**Design:**
- `PortClient` gets a third field, `onDisconnect: (cb: () => void) => void`, so `App.tsx` can register a callback. `port.ts`'s existing `p.onDisconnect` listener invokes it before nulling the port.
- `App.tsx` uses this to set a `connectionLost` boolean, shown as a small inline banner ("Connection to the agent was lost — reconnecting…") on top of whatever phase was last shown, cleared automatically on the next successful message (already-working lazy-reconnect handles the actual reconnect; this only adds the visible signal).
- Crash-resume: change `clearHot()`'s caller in `background/index.ts` to first `patchHot({ phase: 'ABORTED' })` (so any connected panel's `onUpdate` sees the real terminal state) and only then clear — matches what the log message already claims.

**Why not fixed differently:** a full "are you still there" heartbeat/ping protocol would be more robust but is new infrastructure for a rare edge case (SW dying mid-run, not mid-idle — the common idle case is already fixed). A disconnect callback is the minimum that makes the existing failure visible instead of silent.

### 4. Recipe-parity retry × outer replan loop can compound (`orchestrator.ts`, `roles/planner.ts`)

**Root cause:** the planner's internal recipe-parity retry and the orchestrator's outer `replan()` both trigger off `matchedWorkflow` with no shared memory of "already retried this task."

**Design:** track retry state on the hot task state (`hot.recipeRetryUsed?: boolean`, initialized false at task start). The planner's internal retry already fires at most once per `runPlanner` call (self-bounded); the fix is to pass this flag into `runPlanner`'s options and have it skip its own internal retry if the outer loop has already retried once for this task, and set the flag after any retry (inner or outer) fires. This caps the worst case at 2 total extra planner calls instead of ~6, while preserving the existing single-call retry behavior for the common (single replan) case.

**Why not fixed differently:** removing one of the two retries outright would regress a case each was independently added to fix (recipe-parity commit `e5f21aa`, thin-plan retry from [[pipeline-redundancy-and-advanced-concepts]]). Sharing one flag is the smallest change that bounds the compounding without deleting either behavior.

## Deliberately NOT changing

**ARIA cache + `tab.scroll`.** The review found `tab.scroll`-triggered DOM mutations (infinite scroll) aren't covered by the post-action re-extract. Fixing this by adding `tab.scroll` to the re-extract trigger set would force a full `aria.extract` after every scroll — regressing the exact perf/freshness trade-off this codebase already deliberately accepted once (see `deferred-gaps-known-limitations` gap 2: "e4b turns take ~20-30s, so the cache is always wall-clock stale... that's a perf/freshness trade-off the user should weigh, not a silent code change"). No live-reproduced failure exists for this specific case (audit-time finding, not an incident). Per this project's own established pattern, perf/accuracy trade-offs get changed after a live reproduction, not speculatively. This plan only fixes the misleading comment (`actions.ts`'s "scrolling changes nothing on the page" is asserted as universal fact when it's an assumption that fails for infinite-scroll pages) — no runtime behavior change.

## Testing

TDD for all four behavioral fixes above — write the failing test first. Full suite + `tsc --noEmit` + `vite build` green after every task. Pure deletions/doc fixes need no new tests, just the existing suite staying green.
