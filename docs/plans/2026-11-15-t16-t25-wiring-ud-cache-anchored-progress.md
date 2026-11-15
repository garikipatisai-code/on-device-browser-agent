# T16–T25 Progress Ledger — LOCKED (final gate 2026-11-15)

- [x] T16 Flags + DAG wiring (locked): `dagDispatch` flag + `wavesFor` + `dispatchDagPlan` reuse
- [x] T17 Executor threading (deferred per plan — no `runUntilTerminal` call-site change in this seam)
- [x] T18 `${var}` join across waves (deferred per plan)
- [x] T19 Dispatch bench (deferred — measurement only)
- [x] T20 Gate T16–T20 passed (locked): 93 files / 934 tests passed (1 skipped each)
- [x] T21 Flags + canary/kill (locked): `dagDispatch`/`dagCanary`/`dagKill` + `resolveDagEnabled` (kill wins) + extended `dispatchDagPlan` opts
- [x] T22 Executor threading canary/kill-gated runner (deferred to scheduler — NOT in this seam; no call-site change)
- [x] T23 UD wiring (deferred to scheduler — no product-code change unless bench demands it)
- [x] T24 Cache wiring (deferred to scheduler — measurement only unless bench demands it)
- [x] T25 Final gate T16–T25 (BRAIN verify v2, no src edits): TYPE:0 LINT:0 TEST:0 — 98 files passed / 1 skipped (99), 987 tests passed / 1 skipped (988)

## Status: T16–T25 LOCKED + T25 GATE PASSED + Q4 migration verified (2026-11-15 BRAIN live trial)

Gate (2026-11-15 v2 BRAIN verify, `extension/`):
- `npm run typecheck` EXIT:0
- `npm run lint` EXIT:0
- `npm test` EXIT:0 — Test Files 98 passed | 1 skipped (99); Tests 987 passed | 1 skipped (988)

## Debts (carried, not absorbed)
- UD gap needs tag: T23 user-dictionary wiring is scheduler-owned; needs a tracking tag before bench work.
- Scheduler wiring deferred: T22 production threading (`settings.dagDispatch/dagCanary/dagKill` → `dispatchDagPlan` opts via `runHelper`) + T23 UD + T24 cache are scheduler-side follow-ups, out of this BRAIN-only seam.
- T18/T22 open Qs: T18 `${var}` join semantics across waves + T22 canary/kill-gated runner placement (scheduler vs executor seam) need explicit questions/answers before scheduler wiring.

## Evidence
- T16 RED: `extension/tests/unit/t16-flags-dag.test.ts`, 10 failed pre-impl (locked).
- T21 RED/GREEN per `docs/plans/2026-11-15-t21-t25-wiring-ud-cache-anchored.md` (locked; `t21-flags-dag.test.ts` present).
- T25 gate: verify-only run, no src edits. No secrets in code/tests/artifacts.
- Prior: c298297 (T16–T20, 934 passed) ← c9dd667 (T11–T15, 878 passed) ← fdb9f92 (T1–T10, 866 passed).

## Deviation
- Requested lock path `docs/plans/2026-11-15-t16-t25-wiring-ud-cache-anchored-progress.md` was absent; created it (this file) plus sibling `-evidence.json` per repo plan/progress/evidence-triple convention. Root `evidence.json` absent; not created (outside triple convention) — reported, not absorbed.
- Requested spec-path triple references `docs/specs/2026-11-15-t21-t25-wiring-ud-cache-anchored.md`, absent from repo (no `docs/specs/` dir); proceeded on task-brief acceptance criteria as authoritative per plan-file deviation note.
