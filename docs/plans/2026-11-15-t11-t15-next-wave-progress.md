# T11–T15 Next Wave Progress Ledger

## Plan

docs/plans/2026-11-15-t11-t15-next-wave.md (approved human 2026-11-14; prior fdb9f92, 4b5f2a6)

## Status: T15 GATE PASSED (BRAIN verify only, no src edits)

## Tasks

| Task | Title | File(s) | Status | Evidence |
|------|-------|---------|--------|----------|
| T11 | ScaleMCP top-k bound | `extension/src/agent/workflow_memory.ts`, `extension/tests/unit/scalemcp-topk.test.ts` | locked | 7 tests pass; T11 targeted 9/9 with T12 |
| T12 | Cascade prefilter bound | `extension/src/agent/workflow_memory.ts` (`queryCascade` `prefilterTopK`), `extension/tests/unit/scalemcp-topk.test.ts` (T12 block) | locked | 2 tests pass (clamp + cutoff order) |
| T13 | Recall bench top-k no-loss | `extension/tests/unit/flat-retriever.test.ts` (recall@5, 12-parent fixture) | locked | recall@5 target in top 5 of 12, full suite green |
| T14 | Retriever wiring | `extension/src/agent/workflow_memory.ts` (`matchWorkflows` threads `topK`, default 5) | locked | default-5 byte-identical path, full suite green |
| T15 | Final gate | — | passed | TYPE:0 LINT:0 TEST:0 (88 files / 878 tests passed, 1 skipped each) |

## Evidence

- T11 RED: `extension/tests/unit/scalemcp-topk.test.ts` created; asserts topK bound + parent dedup + RRF-60/FLAT preserved.
- T11 GREEN: `normalizeTopK` + `queryTopK` + hardened `query`/`queryCascade` in `workflow_memory.ts`; pure, 0 LLM calls.
- T11 verify: `npx vitest run tests/unit/scalemcp-topk.test.ts` EXIT:0; `npm run typecheck` EXIT:0.
- Properties: dedupe-before-slice; clamp ≤0/NaN→default 5; empty→[]; RRF-60 + FLAT preserved; no new deps; no secrets.
- T15 gate (2026-11-15, BRAIN verify only, no src edits): `npm run typecheck` EXIT:0; `npm run lint` EXIT:0; `npm test` EXIT:0 — 88 files passed / 1 skipped (89), 878 tests passed / 1 skipped (879). T11 targeted: `npx vitest run tests/unit/scalemcp-topk.test.ts` 1 file / 9 tests passed. T13 recall@5 (12-parent fixture, `flat-retriever.test.ts`) green within full suite. No secrets in code/tests/artifacts.
- T15 re-gate after T14 fix (2026-11-15, BRAIN verify only, no src edits): `npm run typecheck` EXIT:0; `npm run lint` EXIT:0; `npm test` EXIT:0 — 88 files passed / 1 skipped (89), 878 tests passed / 1 skipped (879). No secrets.
