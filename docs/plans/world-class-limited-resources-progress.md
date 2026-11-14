# Limited Resources Progress Ledger

## Plan
docs/plans/world-class-limited-resources.md (approved 2026-11-13)

## Tasks

| Task | Title | File(s) | Status | Evidence |
|------|-------|---------|--------|----------|
| T1 | Settings gate — `limitedResources` flag | `extension/src/shared/messages.ts`, `extension/tests/unit/limited_resources.test.ts` | done | T1.1–T1.3: flag added, default false, merge-to-baseline; 2 tests pass EXIT:0; typecheck EXIT:0 |
| T2 | Budget constriction under limitedResources | `extension/src/agent/budget.ts` | done | T2.1–T2.4: `budgetsFor(_, true)` caps every role ≤4096; `capsFor(_, true).page` stays 12000; off path byte-identical (executor baseline 26000); typecheck EXIT:0 |
| T3 | Ollama client constriction under limitedResources | `extension/src/background/ollama.ts` | done | T3.1–T3.4: chat body defaults (temperature 1.0, no format/KV unless set, keep_alive 10m default, OLLAMA_KEEP_ALIVE honored, num_ctx ceiling); typecheck EXIT:0 |
| T4 | Domain-tier fail-closed default under limitedResources | `extension/src/agent/safety/domain_tiers.ts` | done | T4.1–T4.4: 12-case matrix `assertAccessPolicy` == `assertCanAct`; blocklist wins before bypass (file://, javascript: throw even with bypass); click-only requires explicit per-domain opt-in; typecheck EXIT:0 |
| T5 | Redaction walk depth under limitedResources | `extension/src/agent/safety/redact.ts` | done | T5.1–T5.4: `redactDeep` caps at maxDepth 16 (25-deep → `[redacted: too deep]`, no throw; 15-deep walks to leaf); `redactEvent` stays capped at depth 8; typecheck EXIT:0 |
| T6 | Page-tool gating under limitedResources | `extension/src/agent/tools/browser/page.ts` | done | T6.1–T6.5: `page.fetch` SSRF guard blocks private requested URL before fetch; redirect target `response.url` re-checked and blocked; public↔public redirect follows hops; public↔private redirect blocked before body read; public click-only fetch returns body; typecheck EXIT:0 |

## Evidence

- T1.1 RED: `extension/tests/unit/limited_resources.test.ts` created; both tests fail — `DEFAULT_SETTINGS.limitedResources` is `undefined` (not `false`), and the missing-key merge produces an object with an extra `limitedResources: false` key the baseline lacks. (EXIT:1)
- T1.2 GREEN: `limitedResources?: boolean` added after `structuredToolCalls` in `Settings` (messages.ts:101 area); `limitedResources: false` added to `DEFAULT_SETTINGS` (messages.ts:143 area). Vitest: 2 passed (EXIT:0). `npm run typecheck`: EXIT:0.
- T1.3 Verify: full `npm test` — 76 files passed / 1 skipped, 669 tests passed / 1 skipped, EXIT:0; zero regressions. Off path byte-identical (nothing consumes the flag until Tasks 2–6).
- Final verify (this session): `npm run typecheck` EXIT:0; `npx vitest run tests/unit/limited_resources.test.ts tests/unit/budget.test.ts tests/unit/domain_tiers.test.ts` → 3 files passed, 61 tests passed, VERIFY:0. See `docs/plans/world-class-limited-resources-evidence.json`.
