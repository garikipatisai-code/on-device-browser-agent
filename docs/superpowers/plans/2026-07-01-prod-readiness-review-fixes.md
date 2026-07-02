# Prod-readiness review fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every gap found in the 2026-07-01 full-repo review (security/correctness fixes, over-engineering cleanup, doc-drift fixes), verify with the full test/typecheck/build gate after every task, then re-review the diff.

**Architecture:** No new subsystems. Every task is a targeted change inside an existing file/module. Behavioral fixes (Tasks 1-4) are TDD: failing test first. Deletions and doc fixes (Tasks 5-9) need no new test — the existing suite staying green is the acceptance bar.

**Tech Stack:** TypeScript, Vitest, existing repo conventions (see `docs/superpowers/specs/2026-07-01-prod-readiness-review-fixes-design.md` for the design rationale behind Tasks 1-4).

---

### Task 1: Centralize PII redaction in `emit()`

**Files:**
- Modify: `extension/src/agent/orchestrator.ts` (`emit()` around line 950; the `tool.call`/`tool.result` emits around line 440-447)
- Modify: `extension/src/agent/safety/redact.ts` (add `redactEvent`)
- Test: `extension/tests/unit/redact_extra.test.ts` (add cases) or a new `extension/tests/integration/orchestrator.test.ts` case asserting a persisted `tool.call` event has redacted `args`

- [ ] **Step 1: Write the failing test.** In `redact_extra.test.ts`, add a case that calls the new `redactEvent` export with a `{ kind: 'tool.call', ts: 0, tool: 'tab.type', args: { text: 'jane.doe@example.com' } }` event and asserts the returned event's `args.text` does not contain `@example.com` (contains a redaction marker instead — match whatever placeholder `redact()` already uses for email, e.g. `[EMAIL]`). Also add an orchestrator-level integration case (in `tests/integration/orchestrator.test.ts`, following the existing PII test's pattern) that runs a task with a `tab.type` call carrying PII in `args`, then reads back the persisted events via `loadEvents(taskId)` and asserts no raw PII substring appears anywhere in the serialized event.
- [ ] **Step 2: Run tests, confirm they fail** (`redactEvent` doesn't exist yet / persisted args aren't redacted).
- [ ] **Step 3: Implement `redactEvent` in `redact.ts`.** Read the current `redact(text: string): string` implementation and the full `TimelineEvent` union in `shared/messages.ts` first. Add an exported function that: for any event with an `args` field, JSON-stringifies it, runs it through the existing `redact()`, and JSON-parses it back (wrap the parse in try/catch — fall back to a fixed `'[redacted]'` string on parse failure, never throw); for any event with a `content` or `message` string field, runs `redact()` on it directly. Return a new object; do not mutate the input.
- [ ] **Step 4: Wire it into `emit()`.** In `orchestrator.ts`, change `private emit(ev: TimelineEvent)` to redact once: `const safe = redactEvent(ev); this.opts.emit(safe); void appendEvent(this.taskId, safe);`. Remove the now-redundant `redact(...)` call on the `tool.result` emit's `content` field (line ~446) since `emit()` itself now redacts every event — leave the `.slice(0, 2_000)` truncation in place, just drop the inner `redact()` wrapper.
- [ ] **Step 5: Run tests, confirm they pass.** Run: `cd extension && npx vitest run redact orchestrator`. Expected: all pass, including the two new cases.
- [ ] **Step 6: Full gate.** `npm run typecheck && npm test && npm run build` — all green.
- [ ] **Step 7: Commit.** `git add -A && git commit -m "fix(privacy): redact every persisted timeline event centrally in emit(), not per call site"`

---

### Task 2: `reconcileMissingFromCorpus` — fix the false-positive trigger and missing `markDirty`

**Files:**
- Modify: `extension/src/agent/verify/grounding.ts` (`MISSING_RE` / `mentionsMissing`)
- Modify: `extension/src/agent/orchestrator.ts` (`reconcileMissingFromCorpus`, around line 761)
- Test: `extension/src/agent/verify/grounding.test.ts`, `extension/tests/unit/grounding.test.ts`, `extension/tests/integration/orchestrator.test.ts`

- [ ] **Step 1: Write the failing test for the regex.** In `grounding.test.ts`, add: `expect(mentionsMissing("It's not listed at full price — it's on sale for $12.99.")).toBe(false)` (a correct, complete answer describing a price change, not a missing field) alongside the existing true-positive cases (keep those passing). Read the current `MISSING_RE` first to design the narrowest fix: anchor `not listed` (and siblings) to require it describe the SUBJECT as absent, not a price/attribute — the simplest correct fix is requiring the phrase not be immediately followed by "at "/"for "/"on " (which signals "not X at/for/on Y", a comparison, not an absence). Add `(?!\s+(?:at|for|on)\b)` as a negative lookahead after the `not (listed|shown|...)` alternation.
- [ ] **Step 2: Run test, confirm it fails** against the current regex.
- [ ] **Step 3: Implement.** Update `MISSING_RE` in `grounding.ts` with the negative lookahead. Re-run every existing true-positive case in the same test file to confirm none flip to false (a real "not listed" with no trailing "at/for/on" must still match).
- [ ] **Step 4: Write the failing test for `markDirty`.** In `tests/integration/orchestrator.test.ts`, find the existing test(s) covering `reconcileMissingFromCorpus` (the corpus-reconciliation success path). Add an assertion that after a successful reconciliation, the run's dirty-tracking state (however the existing `markDirty` tests assert it — check `orchestrator.test.ts` for how `'finish rejected'`/`'evaluator FAIL'` dirty assertions are written and mirror that exact pattern) reflects `'finish re-answered from corpus'` (or equivalent reason string) as dirty.
- [ ] **Step 5: Run test, confirm it fails** (no `markDirty` call today on this path).
- [ ] **Step 6: Implement.** In `orchestrator.ts`'s `reconcileMissingFromCorpus`, add `this.markDirty('finish re-answered from corpus')` immediately after the `g.verdict === 'success'` branch adopts the corpus answer (same place the `log` event is emitted, around line 770-774).
- [ ] **Step 7: Run tests, confirm they pass.** `npx vitest run grounding orchestrator`.
- [ ] **Step 8: Full gate + commit.** `npm run typecheck && npm test && npm run build`, then `git commit -m "fix(finish): narrow the missing-field regex to skip price/attribute comparisons + mark the run dirty on corpus re-answer"`.

---

### Task 3: Bound the recipe-parity retry × outer replan compounding

**Files:**
- Modify: `extension/src/agent/orchestrator.ts` (hot-state shape, `replan()` call site, wherever `runPlanner` is invoked)
- Modify: `extension/src/agent/roles/planner.ts` (`runPlanner`'s retry branch, around line 112)
- Test: `extension/tests/unit/planner_retry.test.ts`, `extension/tests/integration/orchestrator.test.ts`

- [ ] **Step 1: Write the failing test.** Read `planner_retry.test.ts` first to match its existing mock/harness style. Add a test that calls `runPlanner` twice in a row with the SAME `hot` state object and a workflow match that would trigger the internal retry both times (e.g., a mocked planner response that under-plans relative to the matched recipe on both calls) — assert the retry only actually re-queries the model on the FIRST call (check the mock's call count), and that `hot.recipeRetryUsed` (or whatever field name you land on — keep it consistent with `AgentStateHot`'s existing naming style, check `state_store.ts`/`orchestrator.ts` for the type) is `true` after the first call.
- [ ] **Step 2: Run test, confirm it fails** (no such field/gating exists yet).
- [ ] **Step 3: Implement.** Add `recipeRetryUsed?: boolean` to the `AgentStateHot` type (find its definition — likely `shared/messages.ts` or `orchestrator.ts`; initialize `false` wherever a new hot state is constructed at task start). Thread it into `runPlanner`'s options/args. In `planner.ts`'s retry branch (~line 112), skip the internal retry (return the first plan as-is) if the flag is already `true`; when the retry DOES fire (inner or, separately, whenever the orchestrator's outer `replan()` is invoked), set the flag to `true` on `hot` before returning/replanning.
- [ ] **Step 4: Run tests, confirm they pass.** `npx vitest run planner_retry orchestrator`.
- [ ] **Step 5: Full gate + commit.** `npm run typecheck && npm test && npm run build`, then `git commit -m "fix(planner): bound recipe-parity retry x outer replan compounding with a shared per-task flag"`.

---

### Task 4: Extend recipe quarantine to auto-learned recipes

**Files:**
- Modify: `extension/src/agent/workflow_memory.ts` (`quarantineWorkflow`, around line 636)
- Test: `extension/tests/unit/workflow_hardening.test.ts`, `extension/tests/integration/orchestrator.test.ts`

- [ ] **Step 1: Write the failing test.** In `workflow_hardening.test.ts`, mirror the existing `origin:'user'` quarantine test but construct a stored workflow with `origin: 'auto'` and an id NOT prefixed `user:` (check how auto ids are actually formed in `saveWorkflow`/wherever auto ids are minted, to construct a realistic fixture). Call `quarantineWorkflow(autoId)`, assert it returns `'deleted'` and that a subsequent `loadStored()`-equivalent no longer contains that id. Also add/extend the integration test in `orchestrator.test.ts`'s "user recipe trust/quarantine" describe block (or a sibling describe block) with an `origin:'auto'` case that drives a real failing run and asserts the auto recipe is gone afterward.
- [ ] **Step 2: Run test, confirm it fails** (current code returns `'ignored'` for non-`user:` ids).
- [ ] **Step 3: Implement.** Change `quarantineWorkflow`'s guard from `if (!id.startsWith('user:')) return 'ignored';` to only exempt `builtin` recipes (check however builtin ids/origin are distinguished — likely a `builtin:` prefix or an `origin === 'builtin'` check on the loaded record; look this up before assuming the prefix scheme). For an `origin: 'auto'` recipe: skip the `lastGood` branch entirely (auto recipes never have one) and always delete. For `origin: 'user'`: unchanged existing behavior. For `origin: 'builtin'` (or unresolvable id): keep returning `'ignored'`.
- [ ] **Step 4: Confirm every call site of `quarantineWorkflow`** (grep `orchestrator.ts`) passes whatever id it already has — no call-site changes should be needed since the function itself now handles the auto case; verify this assumption by reading the call site(s) before declaring the task done.
- [ ] **Step 5: Run tests, confirm they pass.** `npx vitest run workflow_hardening orchestrator`.
- [ ] **Step 6: Full gate + commit.** `npm run typecheck && npm test && npm run build`, then `git commit -m "fix(recipes): quarantine auto-learned recipes on failure (delete-only, no lastGood to roll back to)"`.

---

### Task 5: Mid-run service-worker death — visible disconnect signal + honest crash-resume

**Files:**
- Modify: `extension/src/sidepanel/port.ts`
- Modify: `extension/src/sidepanel/App.tsx`
- Modify: `extension/src/background/index.ts` (crash-resume block, around line 150)
- Test: `extension/tests/unit/port.test.ts`, `extension/tests/unit/background_run_lifecycle.test.ts`, `extension/tests/unit/components_render.test.tsx`

- [ ] **Step 1: Write the failing test for `port.ts`.** In `port.test.ts`, add a case: create a `PortClient` with a fake `connect` (matching the existing test's fake-port pattern), register an `onDisconnect` callback, simulate the fake port's `onDisconnect` firing, assert the callback was called exactly once.
- [ ] **Step 2: Run test, confirm it fails** (`onDisconnect` doesn't exist on `PortClient` yet).
- [ ] **Step 3: Implement in `port.ts`.** Add `onDisconnect: (cb: () => void) => void` to the `PortClient` interface. Store the callback in a local variable; call it inside the existing `p.onDisconnect.addListener` handler, before nulling `port`.
- [ ] **Step 4: Write the failing test for crash-resume.** In `background_run_lifecycle.test.ts`, find the existing crash-resume test (or add one) that seeds an in-flight hot state, triggers whatever init path runs the crash-resume block, and assert the resulting stored state's `phase` is `'ABORTED'` (not absent/IDLE) before it's cleared — check how `patchHot`/`clearHot` interact today and whether `clearHot` needs to become "patch to ABORTED, THEN clear on next explicit start" vs "patch and leave it" (read `state_store.ts`'s `clearHot`/`patchHot`/`toStatus` fully before deciding — the requirement is just that a panel connecting between the crash and the next run sees `ABORTED`, not IDLE).
- [ ] **Step 5: Run test, confirm it fails.**
- [ ] **Step 6: Implement in `background/index.ts`.** Change the crash-resume block to `await patchHot({ phase: 'ABORTED' })` instead of immediately clearing; only clear on the next `agent.start`/`agent.reset`-equivalent command (check what already clears hot state at task start and confirm it still does, so `ABORTED` doesn't linger forever).
- [ ] **Step 7: Wire the UI signal in `App.tsx`.** Register `port.onDisconnect(() => setConnectionLost(true))`; clear `connectionLost` on the next received `onUpdate` message (wherever the existing `agent.status`/`SwUpdate` handler is). Render a small inline banner (reuse the existing `Alert.tsx` component if its props fit) when `connectionLost` is true. Add/extend a case in `components_render.test.tsx` asserting the banner renders when the prop/state is set — follow that file's existing smoke-test pattern exactly.
- [ ] **Step 8: Run tests, confirm they pass.** `npx vitest run port background_run_lifecycle components_render`.
- [ ] **Step 9: Full gate + commit.** `npm run typecheck && npm test && npm run build`, then `git commit -m "fix(ui): surface a mid-run service-worker disconnect + make crash-resume report ABORTED instead of silent IDLE"`.

---

### Task 6: Dead-code cleanup (ponytail — no new tests, existing suite must stay green)

**Files:** `extension/src/agent/plan.ts`, `extension/src/agent/budget.ts`, `extension/src/agent/metrics.ts`, `extension/src/agent/workflow_memory.ts`, `extension/src/sidepanel/components/Icon.tsx`

- [ ] Delete `progressFraction` from `plan.ts` (confirm zero callers via `grep -rn progressFraction extension/src extension/tests` first).
- [ ] Delete `truncateSection` from `budget.ts` and its dedicated test case in `tests/unit/budget.test.ts` (confirm zero *production* callers first — the test-only usage is expected and gets deleted with it).
- [ ] Delete the `CompactionRequired` Symbol from `budget.ts` (confirm zero references first).
- [ ] Delete the `BUDGETS` const from `budget.ts` and update the one test that imports it to use `budgetsFor(...)` directly instead (check `budget.test.ts` for the exact import).
- [ ] Remove the unused `meta` param from `timed()` in `metrics.ts` (confirm zero call sites pass it first).
- [ ] Remove the `export` keyword (not the types themselves, if anything else in-file still uses the shape) from `WorkflowStep`/`WorkflowOrigin`/`UserRecipeInput`/`QuarantineResult` in `workflow_memory.ts` if confirmed zero external imports (grep first); if `QuarantineResult` is used as this file's own function return type only, keep it local (`type` without `export`).
- [ ] Remove the dead `dot: ''` entry from the `STROKE` map in `Icon.tsx:9` (confirm the `dot` icon really is special-cased elsewhere first, per the review finding, before deleting).
- [ ] Run: `npm run typecheck && npm test && npm run build` — must stay green after every deletion (delete one at a time if any surprise reference turns up).
- [ ] Commit: `git commit -m "chore: delete dead code found in the 2026-07-01 audit (unused exports, dead const/Symbol)"`.

---

### Task 7: Delete the unwired cloud-egress scaffold

**Files:** `extension/src/agent/safety/anonymize.ts`, its dedicated tests in `extension/tests/unit/pii.test.ts`, the `Settings.cloud` field in `extension/src/shared/messages.ts`

- [ ] Confirm (grep) zero non-test references to `anonymize`/`deanonymize`/`AnonResult`/`DeanonError` outside `anonymize.ts` and `pii.test.ts`, and zero references to `Settings.cloud` outside its own type declaration.
- [ ] Delete `anonymize.ts`.
- [ ] Delete the `anonymize.ts`-specific test cases from `pii.test.ts` (keep whatever else that file tests — check it's not exclusively about `anonymize` before deleting the whole file).
- [ ] Remove the `cloud?: {...}` field from the `Settings` type in `shared/messages.ts` and its entry in `DEFAULT_SETTINGS` if present.
- [ ] Run: `npm run typecheck && npm test && npm run build` — green.
- [ ] Commit: `git commit -m "chore: delete the unwired cloud-egress PII scaffold (Settings.cloud has zero read sites)"`.

---

### Task 8: Collapse the dead `full-action` tier to two real tiers

**Files:** `extension/src/agent/safety/domain_tiers.ts`, `extension/src/sidepanel/components/SettingsPanel.tsx`, `extension/tests/unit/domain_tiers.test.ts`

- [ ] Confirm (grep `required:\s*'full-action'` across `extension/src`) there is truly zero enforcement call site requiring `'full-action'` before removing it — if one turns up, stop and re-scope this task (don't delete a tier something actually depends on).
- [ ] In `domain_tiers.ts`, remove `'full-action'` from the `DomainTier` type / `TIER_ORDER` (check where `DomainTier` is defined — likely `shared/messages.ts` — and update there).
- [ ] In `SettingsPanel.tsx`, remove the `full-action` option from whatever select/radio renders tier choices; if any existing user settings persist `'full-action'` for a domain, decide the safe migration (treat it as `'click-only'` on read, the closer/safer of the two remaining tiers) rather than crashing on an unrecognized value — add this as a one-line fallback in `getDomainTier`.
- [ ] Update `domain_tiers.test.ts` to drop `full-action`-specific assertions and add one asserting a persisted `'full-action'` value from before the migration reads back as `'click-only'`.
- [ ] Run: `npm run typecheck && npm test && npm run build` — green.
- [ ] Commit: `git commit -m "fix(safety): collapse the unenforced full-action tier into click-only (dead granularity, migrate old values)"`.

---

### Task 9: Upload — pierce open shadow roots, fix the error-message honesty

**Files:** `extension/src/agent/tools/browser/upload.ts`, `extension/tests/unit/upload.test.ts`, `extension/tests/unit/upload_dispatch.test.ts`

- [ ] **Step 1: Write the failing test.** In `upload.test.ts`, add a case (following that file's existing DOM-fixture pattern) with a file input nested inside an open `shadowRoot` (`el.attachShadow({mode:'open'})`), assert the upload tool still locates and fills it.
- [ ] **Step 2: Run test, confirm it fails** (`querySelectorAll` doesn't pierce shadow roots).
- [ ] **Step 3: Implement.** In `upload.ts`'s `LOCATE_FN`, replace the single `document.querySelectorAll('input[type=file]')` with a recursive walk: collect matches at the current root, then recurse into `el.shadowRoot` for every element that has one (open roots only — closed roots are unreachable by design, that's fine). Keep it to a small helper function, not a generic DOM-traversal utility.
- [ ] **Step 4: Fix the error-message honesty.** Update the "no file input found" failure message to mention both known-unsupported cases ("it may be inside an iframe or a closed shadow-DOM component, neither supported in v1") instead of only naming iframes.
- [ ] **Step 5: Run tests, confirm they pass.** `npx vitest run upload`.
- [ ] **Step 6: Full gate + commit.** `npm run typecheck && npm test && npm run build`, then `git commit -m "fix(upload): pierce open shadow roots when locating a file input; fix the failure message for the remaining gaps"`.

---

### Task 10: Comment-only honesty fix (no behavior change — see spec's "Deliberately NOT changing")

**Files:** `extension/src/agent/tools/browser/actions.ts` (`tab.scroll` description/comment, around line 227-236)

- [ ] Reword the `tab.scroll` tool description and inline comment so they state the actual known limitation ("scrolling is treated as a read-only viewport move for cache purposes; on infinite-scroll pages this can leave the last-read snapshot stale — re-read with aria.extract if content looks incomplete after scrolling") instead of asserting "scrolling changes nothing on the page" as unconditional fact.
- [ ] Run: `npm run typecheck && npm test` — green (comment-only, no logic touched).
- [ ] Commit: `git commit -m "docs(tools): correct the tab.scroll comment — infinite-scroll pages DO mutate the DOM, cache stays stale by design"`.

---

### Task 11: Doc-drift fixes

**Files:** `docs/job-apply-roadmap.md`, `docs/superpowers/specs/2026-06-22-builtin-recipes-redesign-design.md`, `docs/superpowers/specs/2026-06-17-task-success-benchmark-design.md`, `README.md`

- [ ] `job-apply-roadmap.md`: update the stale header (branch already merged to `main`; test count — replace the fixed "201 tests" figure with a non-numeric phrase like "the full suite", so this doesn't go stale again every time the suite grows).
- [ ] `2026-06-22-builtin-recipes-redesign-design.md`: update "the 6 recipes" framing to note the built-in set has grown since (check the actual current count in `workflow_memory.ts`'s seed list and state the real number, or reword to avoid hardcoding a count that will drift again — prefer "the current built-in set (see `workflow_memory.ts`)" over a hardcoded number).
- [ ] `2026-06-17-task-success-benchmark-design.md`: fix the `scripted_registry.ts` reference to the real filename `scripted_browser.ts`.
- [ ] `README.md`: add one line to the Safety & privacy bullet (or a new bullet) disclosing the `bypassDomainTiers` opt-in checkbox added in commit `9ee3aea`, including the trade-off (any site, no per-domain prompt; protocol blocklist still enforced) — match the design doc's existing framing (`docs/superpowers/specs/2026-06-23-bypass-domain-tiers-design.md`).
- [ ] Commit: `git commit -m "docs: fix stale headers/counts/filenames + document the bypass-domain-tiers checkbox in the README"`.

---

### Task 12: Full re-verification + re-review

- [ ] Run the full gate one more time end-to-end: `npm run typecheck && npm test && npm run build`.
- [ ] Re-run the same 6-subsystem review approach from the 2026-07-01 review against the diff (`git diff main...HEAD`) — dispatch fresh review agents scoped to exactly the files this plan touched, checking (a) each of the 5 fixed findings is actually fixed and didn't introduce a new issue, (b) nothing else regressed.
- [ ] Report final status: what's fixed, what (if anything) the re-review still flags, and confirm the branch is ready for the user's merge decision (do NOT merge to `main` without the user's go-ahead — see `superpowers:finishing-a-development-branch`).
