---
spec: docs/specs/2026-11-15-t26-t30-wiring-executeOne.md
status: approved
approved_by: human
approved_at: 2026-11-14
planner: ses_e22722e96ffeyjjca7AdfEjasn
files: [docs/plans/2026-11-15-t26-t30-wiring-executeOne.md]
allow: [docs/plans/2026-11-15-t26-t30-wiring-executeOne.md, extension/src/shared/messages.ts, extension/src/agent/orchestrator.ts, extension/src/agent/budget.ts, extension/tests/unit/t26-flags-dag.test.ts]
prior_hashes: [5537cba, 08a3386e]
---

# T26–T30 Wiring / executeOne Plan

> **For agentic workers:** T26 is BRAIN-only TDD. Only `extension/src/shared/messages.ts`, `extension/src/agent/orchestrator.ts`, `extension/src/agent/budget.ts`, `extension/tests/unit/t26-flags-dag.test.ts` may be touched. No new deps, no secrets, no network, 0 LLM calls.

**Goal:** Wire the T16/T21 `dispatchDagPlan` seam into `Orchestrator.executeOne` via a settings-derived opts helper. Off/kill path stays byte-identical legacy sequential (single `runHelper` call, no emits); on path (enabled OR canary, no kill) routes the step through `dispatchDagPlan` wave dispatch with a shadow log; cyclic/invalid fails closed to sequential. Multi-step wave fan-out across `runUntilTerminal` stays deferred (T27+).

**Architecture:** Pure helper `dagDispatchOpts(settings, emit?)` in `extension/src/agent/orchestrator.ts` maps `Settings.dagDispatch/dagCanary/dagKill` → `dispatchDagPlan` opts `{ enabled, canary, kill, emit }` (missing flags count as off, fail-closed). `executeOne` builds one `DagStep` (`{ id: stepId, description }`) and routes its single `runHelper` call through `dispatchDagPlan([step], run, dagDispatchOpts(settings, emit))`, taking `outs[0]`. Reuses `resolveDagEnabled` + `wavesFor` + `dispatchDagWave` unchanged. Flags `dagDispatch?/dagCanary?/dagKill?: boolean` on `Settings` already exist from T21 (defaults `false`); no `messages.ts` change expected unless review demands it.

**Tech Stack:** TypeScript, Vitest, existing `extension/src/agent/orchestrator.ts` (`resolveDagEnabled`, `wavesFor`, `dispatchDagWave`, `dispatchDagPlan`), `extension/src/shared/messages.ts` (`Settings`, `DEFAULT_SETTINGS`).

**DEVIATION (2026-11-15):** `docs/specs/2026-11-15-t26-t30-wiring-executeOne.md` is absent from the repo (no `docs/specs/` dir; nearest is `docs/`). Proceeding on the task-brief acceptance criteria as authoritative (RED/GREEN behaviors below); spec-gate items, if any, are unverifiable until the spec lands. Precedent: T21 plan recorded the same deviation for its missing spec.

**Constraints:**
- BRAIN-only: no new deps, no network, no secrets in code/tests/artifacts.
- Deterministic: same step + runner → same result; single-step wave is input-order trivially.
- Fail-closed: invalid graph → sequential fallback, never hang/throw; kill forces off verbatim.
- Default-off: all three flags `false`; missing flags merge to baseline; off path emits nothing.
- 0 LLM calls (injected runner in test; `runHelper` runner in `executeOne`, unchanged call shape).
- Lean: minimum code that passes; out-of-scope files untouched; `budget.ts` listed for cap review only.

**Review Focus:**
- `dagDispatchOpts` mapping: `dagDispatch`→`enabled`, `dagCanary`→`canary`, `dagKill`→`kill`; missing flags → off.
- `resolveDagEnabled` truth table reused; kill wins over enabled + canary.
- Off/kill `executeOne` path: single `runHelper` call preserved verbatim, zero emits.
- On path: single step via `dispatchDagPlan` + one info shadow log; fallback preserved; cyclic → sequential + warn.
- `npx vitest run tests/unit/t26-flags-dag.test.ts` EXIT:0; `npm run typecheck` EXIT:0.
- No secrets in plan/progress/evidence/test.

---

### Task 26: Flags + DAG wiring into executeOne (BRAIN-only TDD) (this session)

**Files:**
- Modify: `extension/src/agent/orchestrator.ts` (add `dagDispatchOpts` + route `executeOne`'s `runHelper` call through `dispatchDagPlan`, reuse `resolveDagEnabled`/`wavesFor`/`dispatchDagWave`)
- Modify: `extension/src/shared/messages.ts` (no change expected — flags landed in T21; listed for review only)
- Modify: `extension/src/agent/budget.ts` (no change expected — listed for cap review only; untouched if no cap needed)
- Test: `extension/tests/unit/t26-flags-dag.test.ts` (new)

Depends on: T6 DAG seam, T16 flags+DAG, T21 canary/kill (all locked).

- [x] **Step 1: Plan + progress/evidence stubs (approved human 2026-11-14)**
- [x] **Step 2: RED — new test asserts `dagDispatchOpts` mapping + off byte-identical, on wave input-order + fallback, cyclic fail-closed, canary/kill override kill-wins (9 failed pre-impl: `dagDispatchOpts is not a function`)**
- [x] **Step 3: GREEN — implemented `dagDispatchOpts` + `executeOne` routing through `dispatchDagPlan` (off verbatim, on waves + shadow log)**
- [x] **Step 4: Verify — `npx vitest run tests/unit/t26-flags-dag.test.ts; echo EXIT:$?` (0, 11 passed) + `npm run typecheck` (0)**
- [x] **Step 5: Return files + outputs, BRAIN, no-secrets**

**Verify:**
- `cd /home/appusai/Documents/Projects/on-device-browser-agent/extension && npx vitest run tests/unit/t26-flags-dag.test.ts; echo EXIT:$?` → EXIT:0
- `cd /home/appusai/Documents/Projects/on-device-browser-agent/extension && npm run typecheck` → EXIT:0

**T26 DEBT (deferred to scheduler, NOT this seam):** no `runUntilTerminal` loop change — multi-step wave fan-out (dispatching independent plan steps across waves instead of one step per `executeOne` call) is T27+ work; T26 routes exactly one step so off stays verbatim and on exercises the wave machinery + shadow log. T27–T30 out of scope.

---

### Task 27: Multi-step wave fan-out in runUntilTerminal (pending)

**Files:** `extension/src/agent/orchestrator.ts` only. Depends on: T26. Dispatch independent plan steps across `wavesFor` waves (per-step `executeOne`-backed runner, `${var}` join via `joinVarRefs`); off/kill byte-identical sequential.

### Task 28: `${var}` join across waves (pending)

Scheduler-owned; `provides`/`joinVarRefs` threading across waves, idempotence review for side-effecting retries.

### Task 29: Dispatch bench (pending)

Scheduler-owned; measurement only unless bench demands product-code change. Needs approval + exact tag before any bench run.

### Task 30: Final gate — type/lint/test full (pending)

Depends on: T26–T29. `npm run typecheck` EXIT:0, `npm run lint` EXIT:0, full `npx vitest run` EXIT:0; update progress ledger + evidence.

---

## Coverage checklist

- [ ] `dagDispatchOpts` maps settings flags → dispatch opts; missing flags merge to baseline (off)
- [ ] `resolveDagEnabled` truth table reused; kill wins
- [ ] Off/kill path: single `runHelper` call preserved verbatim, zero emits
- [ ] On path (enabled or canary, no kill): step via `dispatchDagPlan` wave dispatch, input order, fallback preserved, info shadow log
- [ ] Cyclic on-path: fail-closed sequential fallback + shadow warn log
- [ ] 0 LLM calls, no new deps, no secrets

---

## Progress (stub)

- [x] T26 Step 1: Plan (this file, approved human 2026-11-14)
- [ ] T26 Step 2: RED test (must fail)
- [ ] T26 Step 3: GREEN `dagDispatchOpts` + `executeOne` wiring
- [ ] T26 Step 4: Verify vitest + typecheck (both EXIT:0)
- [ ] T26 Step 5: Return (BRAIN, no-secrets)
- [ ] T27 Multi-step fan-out (deferred)
- [ ] T28 `${var}` join (deferred)
- [ ] T29 Dispatch bench (deferred)
- [ ] T30 Final gate (deferred)

## Evidence (locked T26)

- T26 RED: `extension/tests/unit/t26-flags-dag.test.ts` created; pre-impl run 9 failed (`dagDispatchOpts is not a function`) / 2 passed (pre-existing flag defaults).
- T26 GREEN: `dagDispatchOpts(settings, emit?)` in `orchestrator.ts` maps `dagDispatch/dagCanary/dagKill` → `{ enabled, canary, kill, emit }` (missing flags fail closed to off); `executeOne` routes its single `runHelper` call through `dispatchDagPlan([step], run, opts)`, reusing `resolveDagEnabled`/`wavesFor`/`dispatchDagWave`; off/kill verbatim sequential with zero emits, on wave dispatch + info shadow log, cyclic → sequential + warn, kill wins. `messages.ts`/`budget.ts` untouched (flags + caps already landed in T21).
- T26 verify: targeted vitest EXIT:0 (11 passed); `npm run typecheck` EXIT:0.
- No secrets in code/tests/artifacts.
