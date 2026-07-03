# Agent framework: chef/helper roles + optional frontier/local model tiering

**Date:** 2026-07-02
**Status:** Approved (conversation)

## Problem

The agent's four LLM roles (planner/executor/evaluator/compactor) are peer function calls inside one hand-coded `Orchestrator` state machine — there's no formal seat/contract per role, and every role is hardcoded to the same local `OllamaClient`. Two things are wanted:

1. **A real structure to the roles**, framed as a kitchen: a head chef (decides the plan), a sous chef (checks the work), and helpers (do the tool-calling grunt work) — each a proper unit with a defined contract, not an ad-hoc function call threaded through shared orchestrator state.
2. **Optional model tiering**: let a frontier model (e.g. Claude via API) fill the head-chef/sous-chef seats — the "thinking" roles — while helpers stay on the local on-device model. This must be strictly additive: with no frontier configured, the app behaves exactly as it does today. Local-only is not a fallback mode, it's the unchanged default.

This is phase 1 of a larger initiative (framework/roles → memory ["ingredients"] → tools, each its own spec). Multiple concurrent helpers were considered and deliberately deferred to phase 2 (see below) — the safety layer (circuit breaker, domain tiers, facts ledger) is built assuming one actor and making it concurrency-safe is its own project.

## Principle

Evolutionary, not a rewrite: formalize the four roles as typed functions inside **today's existing control-flow cadence** (head chef once + on replan, helper every turn, sous chef every 3rd turn or on advance/finish). The safety-critical code — domain-tier checks, redaction, circuit breaker, grounding — does not move; it stays exactly where it hangs today, off the one helper's tool-dispatch path and the orchestrator's per-turn loop. Only the calling shape changes: typed messages between named seats instead of loose function params, and a provider indirection so a seat's LLM call can go to a local or frontier backend.

Rejected alternative: a general, reusable multi-agent message-bus framework decoupled from this app. Bigger, riskier, slower, and nobody needs it to be reusable outside this app — rejected on YAGNI grounds.

## Design

### New module: `agent/framework/`

Plain functions, not classes — matches the rest of `agent/` (`runPlanner`, `runExecutor`, etc. are already functions).

```ts
// agent/framework/provider.ts
interface ModelProvider {
  chat(messages: ChatMessage[], opts: ChatOpts): Promise<ChatResult>;
}
function localProvider(ollama: OllamaClient): ModelProvider     // adapts the existing client
function frontierProvider(cfg: FrontierConfig): ModelProvider   // new Anthropic client
function withFallback(primary: ModelProvider, fallback: ModelProvider): ModelProvider

// agent/framework/messages.ts — typed contracts between seats
interface Directive { planStep: PlanStep; guidance?: string }         // head chef -> sous chef / helper
interface Ticket     { instruction: string; context: HelperContext }  // -> helper: one turn's work
interface Report     { toolCall: ToolCall; toolResult: ToolResult }    // helper -> sous chef
interface Verdict    { status: 'pass'|'fail'|'finish'; reason: string; fact?: GroundedFact; shouldReplan?: boolean }

// agent/framework/head_chef.ts, sous_chef.ts, helper.ts
async function runHeadChef(provider: ModelProvider, input: HeadChefInput): Promise<Plan>
async function runSousChef(provider: ModelProvider, ticket: Ticket, report: Report): Promise<Verdict>
async function runHelper(provider: ModelProvider, ticket: Ticket): Promise<Report>
async function runCompactor(provider: ModelProvider, scratch: string): Promise<string>  // standalone, always helper-tier
```

Each wraps its existing `roles/*.ts` counterpart — message-building, parsing, retry/salvage, recipe injection stay exactly as they are today; only the hardcoded `OllamaClient` call becomes `provider.chat(...)`.

**Two decisions worth being explicit about:**

1. **Grounding verification moves from `Orchestrator.verifyFinish` into `runSousChef`.** It's a quality-control check ("does this actually hold up before it goes out") — that's the sous chef's job description, not the coordinator's.
2. **`roles/*.ts` keeps its existing names.** "Head chef / sous chef / helper" name the new wrapper functions in `agent/framework/` only. No renaming of existing files, functions, or tests.

### Provider resolution & config

```ts
// Settings additions (shared/messages.ts), persisted exactly like everything else
hybridMode: boolean;       // one master toggle covers BOTH head-chef and sous-chef seats, default false
frontier?: {
  provider: 'anthropic';   // literal union now; extending to others is a new function, not a redesign
  apiKey: string;
  model: string;
}
```

- `resolveLeadProvider(settings)` → `withFallback(frontierProvider(cfg), localProvider(ollama))` if `hybridMode` is on and a frontier config is present, else `localProvider(ollama)`. Called **once** per run; the same returned `ModelProvider` is passed to both `runHeadChef` and `runSousChef` (they always resolve identically, since there's one master toggle, not two independent ones — no need for a per-role tier parameter here).
- Helper (and the compactor) always get `localProvider(ollama)` directly in this phase — never resolved through `resolveLeadProvider`, never frontier-eligible.
- Resolution happens once at run start (matching how `OllamaClient` is already constructed once in `handleStart` today), not re-read mid-run.
- **Structural guarantee:** with `hybridMode: false` (the default), the lead provider and the helper provider are the same `localProvider(ollama)` — the app runs the identical `roles/*.ts` logic against the same local model as today. This isn't a promise layered on top of the design; it falls out of `resolveLeadProvider` having nothing else to return.

### Fallback on frontier failure

`withFallback` composes at the resolution layer, so `runHeadChef`/`runSousChef` stay unaware fallback exists — they just call `provider.chat()`. Inside it: one retry on a retryable error (5xx, network failure — matches the existing `OllamaClient.withRetry` pattern), no retry on a non-retryable error (401/403 bad key — retrying won't help). Either way, exhausting the retry falls back to `localProvider(ollama)` for that call and emits a `provider.fallback` timeline event so the fallback is visible, not silent (this repo's existing "fail closed, degrade loud" pattern).

### Settings UI

A "Hybrid mode" toggle + frontier provider/model/API-key fields, next to a one-line disclaimer: *"Hybrid mode calls a paid API repeatedly during a run (roughly every 3rd turn) — this app doesn't track or cap that spend."*

## Trade-off (stated plainly)

Turning on hybrid mode means whatever the sous chef needs to judge a step — which can include raw page content — can reach a third-party API. That's an explicit, opt-in, off-by-default trade against this project's "nothing leaves the device" default. With hybrid mode off, behavior and privacy posture are unchanged from today.

## Explicitly NOT doing

- Multiple concurrent helpers — phase 2, once the safety layer is deliberately made concurrency-safe. Not a side effect of this phase.
- Frontier providers beyond Anthropic — the interface allows it; only one implementation is built.
- Renaming `roles/*.ts`, its functions, or its tests to chef terminology.
- Cost/spend tracking or a budget cap — only the Settings disclaimer, not real tracking.
- Adding a redaction pattern for the frontier API key — the key never enters a prompt or an `emit()` payload in the first place, so there's no channel for it to leak through; a regex backstop would be speculative defense for a path that doesn't structurally exist.
- Any change to memory management or the tool layer — separate specs.

## Testing (TDD)

- `resolveLeadProvider`: hybrid off → local; hybrid on + valid config → frontier(+fallback); hybrid on + missing config → local.
- `withFallback`: success passes through untouched; retryable error → one retry → fallback + `provider.fallback` event; non-retryable error → immediate fallback, no retry.
- `frontierProvider` against a mocked HTTP layer (same style as `ollama_chat_error.test.ts`) — no live Anthropic API in tests.
- One explicit regression test: `hybridMode: false` behaves identically to the pre-change baseline (reuse `scripted_e2e.test.ts` fixtures/assertions unchanged as the proof).
- `npm run bench` re-run before/after — the arbiter for whether moving grounding verification into the sous chef regressed real task quality, per this repo's existing norm for grounding/safety changes.
- Existing `roles/*.ts` prompt/parsing tests (evaluator_parse, evaluator_prompt, evaluator_salvage, planner_retry, prompts_*, plan, roles_evaluator — ~10 files) should need little to no change, since that logic doesn't move.

## Implementation notes

New: `agent/framework/{provider,messages,head_chef,sous_chef,helper}.ts`. Touches: `orchestrator.ts` (shrinks to a thin coordinator calling the new functions with the same cadence), `shared/messages.ts` (Settings additions), `state_store.ts` (persist the new Settings fields, same mechanism as existing ones), `sidepanel/components/SettingsPanel.tsx` (hybrid-mode toggle + frontier fields + disclaimer). `roles/*.ts` internals unchanged. Sequence the actual build so the provider/message layer ships and is verified (full suite + bench green) *before* `frontierProvider` and the Settings UI are added on top — two safer steps instead of one risky one.
