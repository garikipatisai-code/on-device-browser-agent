# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome MV3 extension: a goal-anchored autonomous browser agent driven by a local Ollama model (default `gemma4:e4b`, ~4B params) — no cloud, no API keys, nothing leaves the device, **by default**. A `Planner → Executor → Evaluator → Compactor` loop decomposes a plain-language goal, reads pages via an indexed accessibility tree, and acts one tool at a time (click/type/scroll/upload/search) via CDP.

**Optional hybrid mode** lets the planner/evaluator ("lead seat") run on a frontier model (Anthropic direct, or any OpenAI Chat Completions-compatible backend — OpenAI, OpenRouter, DeepSeek, MiniMax, self-hosted) instead of local Ollama. Off by default; when off, the app is byte-identical to the fully-local baseline. Even when on, the executor/compactor ("helper seat") — everything that actually touches the browser — always stays local. See `agent/framework/` below.

All code lives under `extension/`; that's where `package.json` is and where every command below runs from.

## Commands

```bash
cd extension && npm install     # first time
npm run dev                     # vite dev server
npm run build                   # tsc --noEmit && vite build -> extension/dist (load unpacked via chrome://extensions)
npm run typecheck               # tsc --noEmit
npm test                        # vitest run — unit + integration + property; chrome.* and IndexedDB are stubbed in-memory, no real Chrome needed
npm run test:watch
npx vitest run tests/unit/facts.test.ts     # single test file
npx vitest run -t "some test name"          # filter by test name
npm run bench                   # OLLAMA_BENCH=1 vitest run tests/bench/run.bench.test.ts — needs `ollama serve` + models pulled; runs the REAL orchestrator against the REAL local model over scripted fixtures, scores completed/correct/grounded. Override via OLLAMA_BENCH_MODEL / OLLAMA_BENCH_TRIALS / OLLAMA_BENCH_TASK (single task) / OLLAMA_BASE_URL.
node scripts/measure_toolcalls.mjs          # standalone tool-call-syntax reliability probe against a live Ollama (no orchestrator, no vitest)
python scripts/browser_smoke.py             # Selenium smoke test loading the built extension in a real Chrome
```

Requires Chrome 116+, Node 20+, and `ollama serve` running locally with `gemma4:e4b` + `mxbai-embed-large` pulled.

## Architecture

Six pieces, under `extension/src/`:

- **`sidepanel/`** (React) — the only UI. Talks to the background over one `chrome.runtime.Port` (`sidepanel/port.ts`); otherwise treats agent logic as opaque and just renders state.
- **`background/`** — the MV3 service worker. Owns the single `Orchestrator` instance and the Ollama HTTP client (`background/ollama.ts`), persists run/timeline state (`state_store.ts`, `timeline_store.ts`).
- **`agent/`** — the core: `orchestrator.ts` (the loop) + `roles/{planner,executor,evaluator,compactor}.ts` + `prompts/index.ts`.
- **`agent/framework/`** — the "kitchen" seat layer sitting between the orchestrator and `roles/*.ts`: `head_chef.ts` (planner), `sous_chef.ts` (evaluator, also owns grounding verification — `verifyFinish`/`gateFinishSummary`), `helper.ts` (executor + compactor), and `provider.ts` (the `ModelProvider` interface + `localProvider`/`frontierProvider`/`openAICompatibleProvider`/`withFallback`/`withThinkingOverride`/`resolveLeadProvider` — the model-tiering machinery). `roles/*.ts` keep their existing names; only their `ollama` field widened from `OllamaClient` to the structurally-identical `ModelProvider`.
- **`agent/tools/`** — the tool registry + CDP-driven browser actions (`tools/browser/*`: click/type/scroll/upload/search/tab lifecycle) and the ARIA-tree perception pipeline (`aria.ts`).
- **`agent/safety/`** — domain tiers, PII redaction, circuit breaker. Independent, composable checks, not one gate.

**A goal's journey:** side panel sends `agent.start` over the port → background's `handleStart` preflights Ollama, builds a tool registry + `Orchestrator`, starts a 20s keepalive tick, then fires `orch.start()`/`runUntilTerminal()` **without awaiting** — this "detached run loop" is deliberate: MV3 kills an `onMessage` handler after 5 minutes, but a task can run much longer, so the handler returns immediately and the run continues as an unbounded task kept alive only by that keepalive ping (`background/index.ts`). Inside the loop: the loop is **not round-robin** — every turn calls the helper seat (`runHelper`) for one tool call; the sous-chef (`runSousChef`) only runs periodically (every 3rd turn) or right after a step advances/finishes; the head-chef (`runHeadChef`) only re-runs via `replan()`. The compactor (`runHelperCompaction`) only runs when the executor's context budget crosses 80%. Every tool dispatch checks the domain tier *inside the tool itself* before touching CDP (defense in depth, not a single central gate). Every emitted/persisted event passes through one redaction chokepoint (`Orchestrator.emit` → `redactEvent`). The panel's own belief about "is a task running" (`AgentStatus.phase`) is kept fresh by broadcasting a status push from the same per-event path (`appendEventLocal`) the Activity-log stream already uses — it used to only broadcast at start (still `IDLE`) and at finish (already `DONE`), so the panel never saw a real in-progress phase at all; fixed 2026-07-05, see `docs/architecture-map.md`'s "Side panel UI" section for the full story if this area regresses.

**Anti-bot detect-and-pause** (`agent/tools/browser/antibot.ts`, checked from the same post-navigation hook as the consent-dismiss logic): a deterministic regex detector for CAPTCHA/Cloudflare/Akamai-style blocks and generic bot-walls. On a match, sets a new `BLOCKED` phase and polls (no timeout) until the pattern stops matching, then resumes automatically — Stop is the only manual escape hatch. Detect-and-pause only, permanently: never attempts to solve, click through, or bypass anything. See Known gaps/traps below before touching this area.

**Model tiering (`agent/framework/provider.ts`, `Settings.hybridMode`/`Settings.frontier`/`Settings.leadThinking`):** `resolveLeadProvider` decides once per run what backs the head-chef/sous-chef seats — `localProvider(ollama)` when `hybridMode` is off or no frontier config is present (the unchanged default), otherwise a frontier provider wrapped in `withFallback` (one retry on 5xx, then falls back to local, emitting a `log` event so the fallback is visible). `Settings.frontier` is a discriminated union on `provider`: `'anthropic'` hits Claude's Messages API directly; `'openai-compatible'` hits any user-supplied `baseUrl` speaking the OpenAI Chat Completions shape (OpenAI, OpenRouter, DeepSeek, MiniMax, self-hosted — one implementation covers all of them). `Settings.leadThinking` (`undefined`/`true`/`false`) overrides extended-thinking for the lead seat via `withThinkingOverride`, composed as the outermost wrapper so it works identically regardless of which backend serves the request; it's a genuine no-op (same object reference) when unset. The helper seat (executor/compactor) always gets `localProvider(ollama)` directly — never frontier-eligible in this phase. An API key never enters a prompt, an error message, or an `emit()` payload — it only ever appears in a request header.

**Anti-hallucination is the thing this project is most opinionated about.** Finish-time and mid-plan grounding both route through the sous-chef seat (`agent/verify/grounding.ts`, wired into `verifyFinish`/`gateFinishSummary` in `agent/framework/sous_chef.ts`) — **deterministic number-matching** against everything actually read this run, not another LLM call — an LLM-based verifier was tried and reverted because it dropped the benchmark's `correct` rate from 80% to 67% (see `docs/superpowers/specs/2026-06-18-theme-a-page-grounded-verification-design.md`). A small facts ledger (`agent/facts.ts`, ≤24 entries) keeps grounded values alive after raw page text ages out of the ~60KB observed-text window.

**Workflow-memory "recipes"** (`agent/workflow_memory.ts`) are multi-step playbooks — 18 built-in (`SEED_WORKFLOWS`) + learned-from-clean-runs + user-authored — matched to a goal by keyword/domain scoring and injected into the planner prompt. Trust is asymmetric by origin: `auto`-learned recipes get one chance (deleted outright on any friction), `user` recipes roll back to a last-known-good snapshot, `builtin` recipes are untouched.

Full end-to-end trace (component-by-component, safety model in detail, job-apply flow, test coverage shape) is in `docs/architecture-map.md` — read it before re-deriving this from scratch.

## Known gaps / traps

- **job-apply's "never auto-submits" guarantee is prompt/recipe-enforced only, not structural.** No tool-level check stops a click on a button labeled Submit; `ToolContext` doesn't carry a task-type flag. Flag this before leaning harder on the guarantee or extending job-apply.
- **The domain-tier bypass never touches the protocol blocklist** (`file:`, `chrome:`, `javascript:`, `data:`, etc. — `agent/safety/domain_tiers.ts`). `isBlockedUrl` is checked unconditionally before the bypass flag is even read. This ordering is composed at two call sites (`assertCanAct` for tool dispatch, `orchestrator.ts`'s `canActUrl` for the consent-auto-dismiss gate) — both call the same shared primitives, so the check itself can't diverge, but the *ordering* is duplicated, not centralized.
- **Hybrid mode's thinking override is best-effort outside Anthropic and OpenAI itself.** `withThinkingOverride`'s "on" state sends `reasoning_effort:'high'` on the `openai-compatible` path — recognized by OpenAI's own reasoning models, silently ignored by DeepSeek, MiniMax, OpenRouter-routed open models, and self-hosted backends (no standardized field exists to send instead). Not a bug; "Default" and "Always on" are expected to behave identically on those providers.
- **Memory management and a tool-layer upgrade were named in the original request that produced this framework/tiering work, but deliberately shelved** — never brainstormed, speced, or started. Don't propose changes to either area unprompted, and don't infer their shape from the framework work; they'd start from a fresh brainstorm.
- **Anti-bot solving/bypassing is a settled decision, not an open question** — the user asked for it twice (CAPTCHAs/sliders/puzzles, then broadened to any anti-bot situation) and both were declined; detect-and-pause (see above) is the accepted alternative. Don't propose solve/bypass capability if this resurfaces; re-read `docs/superpowers/specs/2026-07-05-antibot-pause-design.md`'s Non-goals section for the reasoning first.
- **Design rationale lives in `docs/superpowers/{specs,plans}/*.md`, dated.** Read the newest-dated doc first — as of this writing that's 2026-07-05, with two unrelated pairs (`antibot-pause`; `run-progress-meter`, which covers only the feature's first iteration — the composer status line and the status-broadcast fix that actually made it visible shipped afterward as direct fixes with no separate spec, so `docs/architecture-map.md`'s "Side panel UI" section is the current source of truth there, not the spec) and 2026-07-04 has `tool-execution-reliability`. All three are independent of, and postdate, the 2026-07-03 `frontier-provider-extensibility` pair, which extends (not replaces) the 2026-07-02 `agent-framework-model-tiering` pair; the 2026-07-01 `prod-readiness-review-fixes` doc is still the authority for everything predating the framework/tiering work. Don't trust an older doc's numbers over the code or the newest doc.
- **Don't reintroduce an LLM-based finish-time verifier without re-benchmarking** (`npm run bench`) — it was tried and measurably regressed correctness (see above). Mechanical checks beat semantic judgment calls for this model size; that pattern recurs deliberately across the safety/grounding code.
- **On-device-only is the default, not an absolute** — hybrid mode is opt-in, off by default, and local-only remains byte-identical when it's off. Don't propose cloud/API-based shortcuts for the *helper* seat (executor/compactor) or as an always-on replacement for local — that breaks the core guarantee. Frontier tiering for the lead seat only, and only when the user explicitly turns it on, is the one sanctioned exception.
