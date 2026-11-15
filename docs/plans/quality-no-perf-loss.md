---
spec: docs/plans/quality-no-perf-loss.md
status: approved
approved_by: human
approved_at: 2026-11-14
files: [docs/plans/quality-no-perf-loss.md]
allow: [docs/plans/quality-no-perf-loss-progress.md, docs/plans/quality-no-perf-loss-evidence.json]
---

# Quality No-Perf-Loss Plan

> **For agentic workers:** T1 is BRAIN-only TDD. Only `extension/src/agent/verify/grounding.ts`, `extension/src/agent/tools/browser/page.ts`, `extension/src/shared/messages.ts`, `extension/tests/unit/finish-gate.test.ts` may be touched. No new deps, no secrets, 0 LLM calls in the gate.

**Goal:** Add a fail-closed finish gate (`isFinishAdmissible` + `getPostState` + `FinishGateResult` `FAIL_CLOSED`/`OK`) so an ungrounded or post-state-failed `finish` can never pass by default. Pure deterministic checks only (numbers already observed + explicit post-state pass), no LLM calls.

**Architecture:** Pure helpers in `extension/src/agent/verify/grounding.ts` reusing `dataNumbers`/`ungroundedNumbers` (no imports from `facts.ts` to avoid a cycle). `getPostState` normalizes a raw check result fail-closed. `isFinishAdmissible` validates args, then post-state, then grounding for data-bearing verdicts. `page.ts` / `messages.ts` remain untouched unless a type must live there (lean: keep the gate in `grounding.ts`).

**Tech Stack:** TypeScript, Vitest, existing `extension/src/agent/verify/grounding.ts` (`ungroundedNumbers`), `extension/src/agent/tools/browser/page.ts` (`page.expect` as the post-state source), `extension/src/shared/messages.ts` (types only if needed).

Spec: `docs/plans/quality-no-perf-loss.md` (this file — Goal/Architecture/Constraints/Review Focus §§, T1 Files + Verify).

**Constraints:**
- BRAIN-only: no new deps, no network, no secrets in code/tests/artifacts.
- Fail-closed: missing args, ungrounded numbers, or missing/failed post-state → `FAIL_CLOSED`, never `OK` by default.
- 0 LLM calls in the gate (mock count 0 in test).
- Lean: minimum code that passes; out-of-scope files untouched.

**Review Focus:**
- `isFinishAdmissible` returns `FAIL_CLOSED` on all three fail modes and `OK` only on grounded + post-state-passed.
- `getPostState` normalizes missing/falsy input to `{ passed: false }`.
- No LLM/provider import in the gate path; test asserts mock count 0.
- `npx vitest run tests/unit/finish-gate.test.ts` EXIT:0; `npm run typecheck` EXIT:0.
- No secrets in plan/progress/evidence/test.

---

### Task 1: Finish gate fail-closed (BRAIN-only TDD) (this session)

**Files:**
- Modify: `extension/src/agent/verify/grounding.ts` (add `isFinishAdmissible` + `getPostState` + `FinishGateResult` `FAIL_CLOSED`/`OK`, 0 LLM calls)
- Test: `extension/tests/unit/finish-gate.test.ts` (new)
- Untouched unless needed: `extension/src/agent/tools/browser/page.ts`, `extension/src/shared/messages.ts`

Depends on: nothing.

- [ ] **Step 1: Plan + progress stubs (draft approved 2026-11-14)**
- [ ] **Step 2: RED — new test asserts `isFinishAdmissible` false on missing args / ungrounded / post-state fail (must fail)**
- [ ] **Step 3: GREEN — implement gate pure + deterministic, `FAIL_CLOSED`/`OK`, mock LLM count 0**
- [ ] **Step 4: Verify — `npx vitest run tests/unit/finish-gate.test.ts; echo EXIT:$?` (0) + `npm run typecheck` (0)**
- [ ] **Step 5: Return files + outputs, BRAIN, no-secrets**

**Verify:**
- `cd /home/appusai/Documents/Projects/on-device-browser-agent/extension && npx vitest run tests/unit/finish-gate.test.ts; echo EXIT:$?` → EXIT:0
- `cd /home/appusai/Documents/Projects/on-device-browser-agent/extension && npm run typecheck` → EXIT:0

---

### Task 6: DAG planner — parse + join + deterministic parallel dispatch (BRAIN-only TDD) (this session)

**Goal:** Add a deterministic DAG-plan seam (`parseDagPlan` + `joinVarRefs` + `dispatchDagWave`) so independent steps fan out via `runHelper` in parallel with a sequential fallback — no extra LLM calls, no perf loss on the sequential path.

**Files:**
- Modify: `extension/src/agent/orchestrator.ts` (add `parseDagPlan` + `joinVarRefs` + `dispatchDagWave`, pure + thin async seam over `runHelper`)
- Modify: `extension/src/shared/messages.ts` (add `DagStep` type only)
- Test: `extension/tests/unit/dag-planner.test.ts` (new)

Depends on: T1–T5 (passed, locked 2026-11-14).

- [x] **Step 1: Plan + progress stubs (T6 in-progress, T7–T10 pending)**
- [ ] **Step 2: RED — new test asserts `parseDagPlan` shape/needs, `joinVarRefs` `${var}` substitution, parallel dispatch deterministic order + sequential fallback (must fail)**
- [ ] **Step 3: GREEN — implement `parseDagPlan`/`joinVarRefs` pure + deterministic, `dispatchDagWave` fan-out via `runHelper`, fallback sequential**
- [ ] **Step 4: Verify — `npx vitest run tests/unit/dag-planner.test.ts; echo EXIT:$?` (0) + `npm run typecheck` (0)**
- [ ] **Step 5: Return files + outputs + plan sha, BRAIN, no-secrets**

**Verify:**
- `cd /home/appusai/Documents/Projects/on-device-browser-agent/extension && npx vitest run tests/unit/dag-planner.test.ts; echo EXIT:$?` → EXIT:0
- `cd /home/appusai/Documents/Projects/on-device-browser-agent/extension && npm run typecheck` → EXIT:0

**Constraints:**
- BRAIN-only: no new deps, no network, no secrets in code/tests/artifacts.
- Deterministic: `Promise.all` input-order results; missing `${var}` → `''`; invalid plan → `[]` fail-closed.
- 0 extra LLM calls on the sequential path (injected runner seam; `runHelper` only for wave steps).
- Lean: minimum code that passes; out-of-scope files untouched.

### Task 7: DAG executor wiring — waves into execute path (pending)

**Files:** `extension/src/agent/orchestrator.ts`, `extension/tests/unit/dag-planner.test.ts` (extend). Depends on: T6. Level independent steps through the T6 wave seam; sequential path byte-identical.

### Task 8: DAG guards — cycle + join-depth limits (pending)

**Files:** `extension/src/agent/orchestrator.ts`, `extension/tests/unit/dag-planner.test.ts` (extend). Depends on: T6. Fail-closed on cyclic `needs` and over-deep `${var}` chains; deterministic rejection.

### Task 9: Bench — parallel vs sequential no-perf-loss (pending)

**Files:** measurement only, no product-code change unless the bench demands it. Depends on: T6–T8. Parallel waves never slower than sequential on the independent-step bench; 0 extra LLM calls asserted.

### Task 10: Final gate — type/lint/test full (pending)

Depends on: T6–T9. `npm run typecheck` EXIT:0, `npm run lint` EXIT:0, full `npx vitest run` EXIT:0; update progress ledger + evidence.

---

## Coverage checklist

- [ ] `isFinishAdmissible` false on missing args
- [ ] `isFinishAdmissible` false on ungrounded numbers
- [ ] `isFinishAdmissible` false on post-state fail/missing
- [ ] `isFinishAdmissible` true only on grounded + post-state passed (`OK`)
- [ ] `getPostState` fail-closed normalization covered
- [ ] `FinishGateResult` carries `FAIL_CLOSED` / `OK`
- [ ] 0 LLM calls (mock count 0 asserted in test)
- [ ] No new deps, no secrets
