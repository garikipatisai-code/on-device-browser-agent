# Theme D (orchestrator de-bloat) + Perception tail (#4, #5) — Plan

**Date:** 2026-06-19
**Branch:** `feat/theme-d-orchestrator-cleanup`

## Context
Theme A + Theme B's substantive work is merged. Remaining: the low-value perception tail (#4 dynamic freshness, #5 post-nav timing) and Theme D (the orchestrator has grown to ~620 lines; `executeOne` alone is ~175 lines doing six things). Doing all three in one focused pass. **Refactors are behavior-preserving — the 229-test suite is the safety net.** Each piece is TDD'd and verified (suite + typecheck + build) before the next.

## #5 — Condition-based post-navigation wait
**Problem:** the auto-observe sleeps a fixed `sleep(1200)` before re-reading (twice — pre-read and post-consent-dismiss). Too slow for fast pages, too short for slow ones.
**Fix:** generalize `tab.ts`'s polling into an exported `waitForTabSettled(tabId, capMs=5000, pollMs=150)` — resolves as soon as the tab is `complete`, on tab-gone, or at the cap (never throws). Replace both `sleep(1200)` calls. The existing `getAxNodes` retry already handles post-`complete` SPA hydration.
**Files:** `src/agent/tools/browser/tab.ts` (add `waitForTabSettled`), `src/agent/orchestrator.ts` (use it). **Test:** `tests/unit/tab_wait.test.ts` — complete→fast; loading→complete→waits then resolves; tab-gone→immediate; never-complete→resolves at cap. Bonus: speeds up the integration suite (removes the real 1.2–2.4 s sleeps).

## #4 — Stale element-index detection
**Problem:** `resolveBackendId` trusts the cache when the URL is unchanged; on a same-URL DOM mutation the cached node is detached, and the action fails with a cryptic "Element has no box model" (or silently no-ops).
**Fix:** in the index-based actions (`tab.click`/`tab.type`/`tab.select`), after resolving the node, verify `this.isConnected` via `Runtime.callFunctionOn`; if detached, return a clear ToolResult error: *"element [N] is stale — the page changed since your last read; call aria.extract to refresh, then act on the new indices."*
**Files:** `src/agent/tools/browser/actions.ts` (shared `assertConnected` helper used by the three index actions). **Test:** `tests/unit/actions_stale.test.ts` — mock `chrome.debugger` so `isConnected` returns false → `tab.click` yields the stale error; returns true → proceeds.

## Theme D — de-bloat `executeOne` (behavior-preserving method extraction)
**Problem:** `executeOne` is a 175-line god-method. **Fix:** extract three focused private methods (pure code moves — no behavior change):
- `buildToolCtx(hot, stepId): ToolContext` — the `ToolContext` literal (incl. `addFinding`).
- `autoObserveAfterNavigation(out, toolCtx): Promise<void>` — the post-nav settle → `aria.extract` → consent-dismiss → re-read block (~65 lines), updating `lastRead`/`observedText`/`lastObserveTool` and emitting the same logs.
- `recordTurn(out, scratch): Promise<void>` — scratchpad append + `READING_TOOLS` carry-forward + breaker + `recentActions` + `trace`.

After extraction `executeOne` reads as: build ctx → (compact) → run executor → emit action → `autoObserveAfterNavigation` → `recordTurn` → role.end. **Verification is the existing integration tests** (auto-read visibility, consent dismissal, carries-page-forward, observe-gate) — they must stay green, proving behavior is preserved.

**Explicitly deferred (out of scope, noted for the future):** module-level singleton caches (`search._lastResults`, `aria_tool._cache`) → instance state; full module-level decomposition of the orchestrator; the `.catch(() => null)` swallows in auto-observe (intentional — the `warn` log already surfaces the visible failure).

## Order & verification
#5 → #4 → Theme D. TDD each (RED→GREEN). After all three: full suite + `tsc --noEmit` + `vite build`, then commit per piece on `feat/theme-d-orchestrator-cleanup`.
