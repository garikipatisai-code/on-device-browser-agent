# 09 — Implementation Roadmap

Build in this order. Each phase is a working checkpoint — don't start the
next until the current one passes tests end-to-end.

## M1 — Extension scaffold + Ollama streaming chat

**Goal:** Chrome extension loads, user types a message, gets a streamed
response from a local model.

**Files to create:**
- `extension/` — Vite + CRXJS + React + TypeScript scaffold
- `src/manifest.ts` — MV3 manifest with sidePanel + storage permissions
- `src/background/index.ts` — SW entry, message routing
- `src/background/ollama.ts` — `chatStream()` with SSE parsing
- `src/sidepanel/App.tsx` — Chat UI (input + message list)
- `src/shared/messages.ts` — SW ↔ Panel message types

**Tests:** Manual browser test. Does the chat work?

**Success criteria:**
- Extension loads in Chrome without errors
- User can type a message and see a streamed response
- Ollama CORS configured (`OLLAMA_ORIGINS="chrome-extension://*"`)

## M2 — Full agent loop

**Goal:** Planner → Executor → Evaluator loop works end-to-end with
mock tools and fake Ollama client.

**Files to create:**
- `src/agent/orchestrator.ts` — State machine, `runUntilTerminal()`
- `src/agent/roles/planner.ts` — Goal decomposition
- `src/agent/roles/executor.ts` — Tool selection + calling
- `src/agent/roles/evaluator.ts` — Step verdict
- `src/agent/roles/compactor.ts` — Context compaction
- `src/agent/prompts/*.ts` — Role prompt templates
- `src/agent/tools/registry.ts` — Tool dispatch
- `src/agent/safety/circuit_breaker.ts`
- `src/agent/budget.ts` — Token counting
- `src/background/state_store.ts` — chrome.storage.local + IDB
- `tests/` — Vitest setup, orchestrator tests

**Tests:** 100+ mock tests. Orchestrator integration with fake Ollama.
Goal byte-survival test.

**Success criteria:**
- Agent loop completes a 3-step mock task
- Goal survives replan (test asserts byte-equality)
- Circuit breaker trips on repeated actions
- All tests pass in < 30 seconds

## M3 — Real browser tools

**Goal:** Agent can read pages, search the web, and manage tabs.

**Files to create:**
- `src/agent/tools/browser/aria.ts` — ARIA tree extraction
- `src/agent/tools/browser/tab.ts` — Tab open/close/list/screenshot
- `src/agent/tools/browser/search.ts` — DDG web search
- `src/agent/tools/browser/actions.ts` — CDP click/type/select
- `src/agent/tools/browser/lifecycle.ts` — CDP attach/detach
- `src/agent/safety/domain_tiers.ts` — Domain gating
- `src/manifest.ts` — Add `tabs`, `debugger`, `activeTab` permissions

**Tests:** 100+ new tests. Amazon product extraction. DDG parser.

**Success criteria:**
- `aria.extract` returns simplified ARIA tree from a real page
- `search` returns parsed DDG results
- `tab.open` navigates to a URL
- All browser tools timeout-guarded (no hung CDP operations)
- Domain tier gating blocks actions on unapproved hosts

## M3.5 — Safety, PII, metrics

**Goal:** Production-grade safety and observability.

**Files to create:**
- `src/agent/safety/redact.ts` — PII redaction
- `src/agent/safety/anonymize.ts` — Reversible PII for cloud
- `src/agent/metrics.ts` — Latency + success rate telemetry
- `src/background/signal.ts` — Leak-free AbortSignal

**Tests:** 50+ new tests. PII redaction. Metrics accuracy.

**Success criteria:**
- PII redacted at persistence boundary
- Per-op metrics collected and queryable
- No timer leaks (test verifies setTimeout/clearTimeout pairing)

## M4 — Shopping domain

**Goal:** End-to-end deal hunting across retailers.

**Files to create:**
- `src/agent/tools/retailers/amazon.ts`
- `src/agent/tools/retailers/walmart.ts`
- `src/agent/tools/retailers/bestbuy.ts`
- `src/agent/tools/retailers/framework.ts` — Adapter interface
- `src/sidepanel/components/DealComparison.tsx`

**Tests:** Retailer adapter tests. Real-page integration tests.

**Success criteria:**
- Agent can find and compare products across 3+ retailers
- Price extraction is accurate (integer cents)
- Product data normalized across retailers

## M5 — Polish

**Goal:** User-ready experience.

**Work items:**
- Error recovery UX (clear messages, retry suggestions)
- Settings UI (model config, domain tiers, API keys)
- Onboarding flow (first-run setup, permissions)
- Icons and branding
- Price history tracking
- Coupon detection

## Model setup (pre-flight)

Before the agent starts, run pre-flight checks:

```typescript
async function preflightCheck(client: OllamaClient, settings: Settings): Promise<void> {
  // 1. Ping Ollama
  const ok = await client.ping();
  if (!ok) throw new Error('Ollama not reachable');

  // 2. Verify all configured models are pulled
  const available = await client.listModels();
  const required = [
    settings.executorModel,   // e.g., gemma4:2b
    settings.plannerModel,    // e.g., gemma4:26b
    settings.evaluatorModel,  // e.g., gemma4:4b
    settings.embeddingModel,  // e.g., mxbai-embed-large
  ];
  for (const model of required) {
    if (!available.includes(model)) {
      throw new Error(`Model ${model} not pulled. Run: ollama pull ${model}`);
    }
  }
}
```

**Pre-flight runs on `handleAgentStart`** — before constructing the
orchestrator. A typo'd URL or missing model fails in seconds, not the
5-minute Planner timeout.

## Real-browser validation

After each phase, run `scripts/browser_smoke.py`:

```python
# Tests page actions (click, type, select) mutate a real page
# Tests search returns results
# Tests ARIA extraction works on a live site
# Optionally tests cloud round-trip (POLARIS_SMOKE_CLOUD=1)
```

This catches Chrome version compatibility issues (CDP API changes,
manifest requirements) that mock tests miss.
