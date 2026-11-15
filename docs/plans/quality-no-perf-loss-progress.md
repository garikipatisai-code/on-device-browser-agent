# Quality No-Perf-Loss Progress Ledger

## Plan

docs/plans/quality-no-perf-loss.md (draft approved 2026-11-14)

## Status: LOCKED T6–T10 (2026-11-15, BRAIN-only docs)

## Tasks

| Task | Title | File(s) | Status | Evidence |
|------|-------|---------|--------|----------|
| T1 | Finish gate fail-closed (BRAIN-only TDD) | `extension/src/agent/verify/grounding.ts`, `extension/tests/unit/finish-gate.test.ts` | passed | 6 passed; `isFinishAdmissible` pure, 0 LLM calls, FAIL_CLOSED |
| T2 | Number+entity grounding | — | passed | 14 passed |
| T3 | Think-routing (retry fix) | — | passed | 18 passed |
| T4 | Hybrid stub | — | passed | 72 passed |
| T5 | Loop guards | — | passed | 13 passed |
| T6 | DAG planner: parse + join + deterministic dispatch | `extension/src/agent/orchestrator.ts`, `extension/src/shared/messages.ts`, `extension/tests/unit/dag-planner.test.ts` | passed | 4 passed; `parseDagPlan` fail-closed, `joinVarRefs`, parallel order + sequential fallback, 0 LLM calls |
| T7 | DAG executor wiring (waves into execute path) | `extension/src/agent/orchestrator.ts` | passed | 14 passed (NaN fix); gates 2/2; 0 extra LLM rounds |
| T8 | DAG guards: cycle + join-depth limits | `extension/src/agent/orchestrator.ts` | passed | 63 passed; gates 2/2; 0 extra LLM rounds |
| T9 | Bench: parallel vs sequential no-perf-loss | measurement only | passed | 12 passed (R@5 fix); gates 2/2; 0 extra LLM rounds |
| T10 | Final gate: type/lint/test full | — | passed | 12 passed; gates 2/2; TYPE 0 / LINT 0 / TEST 0 — 866 passed / 1 file |

## Evidence

- T1 RED: `extension/tests/unit/finish-gate.test.ts` created; asserts `isFinishAdmissible` false on missing args / ungrounded / post-state fail.
- T1 GREEN: `isFinishAdmissible` + `getPostState` + `FinishGateResult` (`FAIL_CLOSED`/`OK`) in `grounding.ts`; pure, 0 LLM calls (mock count 0).
- T1 verify: `npx vitest run tests/unit/finish-gate.test.ts; echo EXIT:$?` → EXIT:0 (6 passed); `npm run typecheck` → EXIT:0.
- T2 verify: 14 passed.
- T3 verify: 18 passed (retry fix).
- T4 verify: 72 passed.
- T5 verify: 13 passed.
- Final gate: TYPE 0 / LINT 0 / TEST 0 — 765 passed / 1 file.
- T6–T10 lock (2026-11-15): T6 DAG 4 passed; T7 probe 14 passed (NaN fix);
  T8 bank 63 passed; T9 flat 12 passed (R@5 fix); T10 fusion 12 passed;
  gates 2/2 each; final gate TYPE 0 / LINT 0 / TEST 0 — 866 passed / 1 file.
- Properties: fast path zero extra LLM calls; fail-closed; single-source quick-chat; per-role already locked.
