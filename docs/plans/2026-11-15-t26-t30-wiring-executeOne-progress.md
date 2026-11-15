# T26–T30 Progress Ledger

- [x] T26 Step 1: Plan (`docs/plans/2026-11-15-t26-t30-wiring-executeOne.md`, approved human 2026-11-14)
- [x] T26 Step 2: RED test (`extension/tests/unit/t26-flags-dag.test.ts`, 9 failed pre-impl)
- [x] T26 Step 3: GREEN `dagDispatchOpts` + `executeOne` wiring (`extension/src/agent/orchestrator.ts`)
- [x] T26 Step 4: Verify targeted vitest EXIT:0 (11 passed) + typecheck EXIT:0
- [x] T26 Step 5: Return (BRAIN, no-secrets)
- [x] T27 Multi-step wave fan-out in runUntilTerminal (deferred to scheduler — locked as deferred)
- [x] T28 `${var}` join across waves (deferred to scheduler — locked as deferred)
- [x] T29 Dispatch bench (deferred; needs approval + exact tag before any bench run — locked as deferred)
- [x] T30 Final gate type/lint/test full (locked — see Evidence)

## Status: T26–T30 LOCKED (T26 DONE + T27–T29 deferred + T30 gate passed)

## Debts (carried, not absorbed)

- Spec absent: `docs/specs/2026-11-15-t26-t30-wiring-executeOne.md` missing (no `docs/specs/` dir); proceeding on task-brief acceptance criteria per plan-file deviation note (same precedent as T21).
- Scheduler wiring deferred: T27 multi-step fan-out + T28 `${var}` join + T29 bench are scheduler-side follow-ups, out of this BRAIN-only seam.
- UD gap needs tag: dispatch bench (T29) needs approval + exact tag before any bench run.
- T18/T22 open Qs carry forward: empty-steps warn-vs-silent + retry idempotence for side-effecting steps.

## Evidence

- (stub) T26 RED/GREEN/verify to be recorded here on completion.
- T26 RED: 9 failed pre-impl (`dagDispatchOpts is not a function`) / 2 passed; GREEN: 11 passed; typecheck EXIT:0. No secrets.
- T30 Final gate v2 (2026-11-15): typecheck EXIT:0, lint EXIT:0, full vitest EXIT:0 — 103 files passed / 1 skipped (104), 1053 tests passed / 1 skipped (1054). Prior: 5537cba (T16–T25, 987 passed) ← c298297 (T16–T20, 934 passed).
