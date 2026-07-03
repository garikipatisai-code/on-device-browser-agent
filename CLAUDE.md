# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome MV3 extension: a goal-anchored autonomous browser agent driven entirely by a local Ollama model (default `gemma4:e4b`, ~4B params) — no cloud, no API keys, nothing leaves the device. A `Planner → Executor → Evaluator → Compactor` loop decomposes a plain-language goal, reads pages via an indexed accessibility tree, and acts one tool at a time (click/type/scroll/upload/search) via CDP.

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

Five pieces, under `extension/src/`:

- **`sidepanel/`** (React) — the only UI. Talks to the background over one `chrome.runtime.Port` (`sidepanel/port.ts`); otherwise treats agent logic as opaque and just renders state.
- **`background/`** — the MV3 service worker. Owns the single `Orchestrator` instance and the Ollama HTTP client (`background/ollama.ts`), persists run/timeline state (`state_store.ts`, `timeline_store.ts`).
- **`agent/`** — the core: `orchestrator.ts` (the loop) + `roles/{planner,executor,evaluator,compactor}.ts` + `prompts/index.ts`.
- **`agent/tools/`** — the tool registry + CDP-driven browser actions (`tools/browser/*`: click/type/scroll/upload/search/tab lifecycle) and the ARIA-tree perception pipeline (`aria.ts`).
- **`agent/safety/`** — domain tiers, PII redaction, circuit breaker. Independent, composable checks, not one gate.

**A goal's journey:** side panel sends `agent.start` over the port → background's `handleStart` preflights Ollama, builds a tool registry + `Orchestrator`, starts a 20s keepalive tick, then fires `orch.start()`/`runUntilTerminal()` **without awaiting** — this "detached run loop" is deliberate: MV3 kills an `onMessage` handler after 5 minutes, but a task can run much longer, so the handler returns immediately and the run continues as an unbounded task kept alive only by that keepalive ping (`background/index.ts`). Inside the loop: the loop is **not round-robin** — every turn calls the Executor for one tool call; the Evaluator only runs periodically (every 3rd turn) or right after a step advances/finishes; the Compactor only runs when the executor's context budget crosses 80%. Every tool dispatch checks the domain tier *inside the tool itself* before touching CDP (defense in depth, not a single central gate). Every emitted/persisted event passes through one redaction chokepoint (`Orchestrator.emit` → `redactEvent`).

**Anti-hallucination is the thing this project is most opinionated about.** Finish-time grounding (`agent/verify/grounding.ts`, wired in `orchestrator.ts`'s `verifyFinish`) is **deterministic number-matching** against everything actually read this run, not another LLM call — an LLM-based verifier was tried and reverted because it dropped the benchmark's `correct` rate from 80% to 67% (see `docs/superpowers/specs/2026-06-18-theme-a-page-grounded-verification-design.md`). A small facts ledger (`agent/facts.ts`, ≤24 entries) keeps grounded values alive after raw page text ages out of the ~60KB observed-text window.

**Workflow-memory "recipes"** (`agent/workflow_memory.ts`) are multi-step playbooks — 16 built-in + learned-from-clean-runs + user-authored — matched to a goal by keyword/domain scoring and injected into the planner prompt. Trust is asymmetric by origin: `auto`-learned recipes get one chance (deleted outright on any friction), `user` recipes roll back to a last-known-good snapshot, `builtin` recipes are untouched.

Full end-to-end trace (component-by-component, safety model in detail, job-apply flow, test coverage shape) is in `docs/architecture-map.md` — read it before re-deriving this from scratch.

## Known gaps / traps

- **job-apply's "never auto-submits" guarantee is prompt/recipe-enforced only, not structural.** No tool-level check stops a click on a button labeled Submit; `ToolContext` doesn't carry a task-type flag. Flag this before leaning harder on the guarantee or extending job-apply.
- **The domain-tier bypass never touches the protocol blocklist** (`file:`, `chrome:`, `javascript:`, `data:`, etc. — `agent/safety/domain_tiers.ts`). `isBlockedUrl` is checked unconditionally before the bypass flag is even read. This ordering is composed at two call sites (`assertCanAct` for tool dispatch, `orchestrator.ts`'s `canActUrl` for the consent-auto-dismiss gate) — both call the same shared primitives, so the check itself can't diverge, but the *ordering* is duplicated, not centralized.
- **Design rationale lives in `docs/superpowers/{specs,plans}/*.md`, dated.** Read the newest-dated doc first — the 2026-07-01 `prod-readiness-review-fixes` doc is the current authority and explicitly corrects stale claims (recipe counts, test counts) in several earlier docs. Don't trust an older doc's numbers over the code or the newest doc.
- **Don't reintroduce an LLM-based finish-time verifier without re-benchmarking** (`npm run bench`) — it was tried and measurably regressed correctness (see above). Mechanical checks beat semantic judgment calls for this model size; that pattern recurs deliberately across the safety/grounding code.
- **This is an on-device-only project by design** — no cloud dependency, no API keys. Don't propose cloud/API-based shortcuts as fixes; they break the core guarantee.
