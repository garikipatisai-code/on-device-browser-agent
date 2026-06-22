# Agent memory / context / harness — grounded facts ledger

**Date:** 2026-06-22
**Status:** Approved (conversation)

## Problem

The on-device agent (single local gemma4:e4b 4B; Planner→Executor→Evaluator→Compactor loop) loses facts it has already gathered partway through a multi-step run. On a task like "compare the population of 5 cities" or "research X across 5 pages," the values read on early turns are gone from the model's context by the synthesis turn, causing re-reads, replan storms, or ungrounded finishes.

## Root cause (verified against code)

The agent's durable in-run memory is a **lossy rolling text scratchpad**, while the two *relevant* stores it already maintains are **never fed back into the model's prompts**:

| Store | Size | In executor/evaluator prompt? | Citation |
|---|---|---|---|
| Scratchpad (800-char result tails) | 12 K rolling, **drops oldest** | yes, but lossy | `orchestrator.ts:545` |
| `lastRead` (full page) | 12 K, **latest page only** | yes | `orchestrator.ts:536`, `:631` |
| `observedText` (all reads) | 60 K rolling | **no** — only finish-grounding + salvage | `orchestrator.ts:598`, `:678` |
| `findings` rail (structured) | — | **no** — wired in prompt, never populated | see below |

Three confirmed facts:

1. **The findings rail is dormant end-to-end.** The prompt templates have a `FINDINGS:` slot for both executor (`prompts/index.ts:137`) and evaluator (`prompts/index.ts:199`), fed from `ctx.findingsBlock`. But `commonCtx` (`orchestrator.ts:620`) never sets `findingsBlock`, and no tool calls the `addFinding` hook exposed at `orchestrator.ts:442`. So findings are write-capable but never written, and the slot is always empty.

2. **Compaction never fires.** `shouldCompact` requires `tokens > 26000 * 0.8 = 20800` (`budget.ts:43`, `:20`, `:25`) ≈ ~83 K chars, but the 12 K scratchpad + 12 K page caps keep the executor prompt near ~10 K tokens. So instead of *summarizing*, `scratchpad.slice(-12_000)` (`orchestrator.ts:545`) silently drops the **oldest** turns. A dead `truncateSection` helper (`budget.ts:47`) is never called.

3. **A mid-plan prose answer advances the plan with no grounding check.** When the executor writes prose instead of calling a tool, it is returned as `{tool:'answer', advanceStep:true}` (`executor.ts:90-103`). The grounding gate runs only at finish (`orchestrator.ts:206`) and on the final-step answer (`:244-247`); a non-final prose-answer at `:224` advances purely on evaluator PASS, ungrounded.

This is the same gap previously flagged as deferred. The correct fix is **not** to enable lossy 4B compaction (deliberately rejected before). It is what `budget.ts:16` already states: *"a big window holding RELEVANT state beats a big window of raw dump."* Curate a small, grounded ledger of the facts that matter and keep it always in context.

## Principle

Promote the **facts that matter** out of the lossy scratchpad into a structured, bounded, always-in-context ledger — and ground everything that enters durable memory. Activate infrastructure that already exists (findings rail, `addFinding` hook, `ungroundedNumbers` helper) rather than adding new subsystems.

## Design — grounded facts ledger (all three pillars)

A small in-memory ledger in the orchestrator, mirrored to the existing findings store for crash-resume:

- **State:** `this.facts: { step: string; text: string; url?: string }[]` — bounded (≤ 24 entries / ≤ ~4 K chars rendered), deduped on near-identical `text`.
- **Capture (memory):** the evaluator returns one optional short `fact` field on a completed step — the concrete datum the step established, or `null`. The orchestrator grounds it (`ungroundedNumbers(fact, observedText)`); if clean, push to `this.facts` **and** `addFinding({ taskId, kind:'fact', data:{step,text,url} })`. A truncated, empty, or ungrounded fact is silently skipped — capture is purely additive and never breaks the run.
- **Inject (memory):** `commonCtx` renders `this.facts` into `findingsBlock` (synchronous, in-memory), so the ledger appears in every executor + evaluator prompt via the existing `FINDINGS:` slot.
- **Grounding durability (context):** finish-grounding (`verifyFinish` / `ungroundedNumbers`) checks numbers against **ledger ∪ observedText**, so a fact promoted to the ledger survives 60 K FIFO eviction → no false "unverified" downgrades on long runs.
- **Mid-plan grounding (harness):** the non-final prose-answer path (`orchestrator.ts:224`) routes through the same grounding gate as finish — the plan cannot advance on fabricated prose; ledger entries are grounded by construction.
- **Resume:** on SW-restart mid-task, rehydrate `this.facts` from `getFindings(taskId)` (`state_store.ts:313`).

### Failure mode → guardrail

| Failure mode | Guardrail |
|---|---|
| early facts dropped from the 12 K scratchpad before synthesis | structured ledger, always injected, not subject to the rolling truncation |
| earlier page reads invisible during execution (`observedText` never injected) | the established datum from each step is promoted to the ledger |
| early page evicted from 60 K FIFO → correct answer flagged "unverified" | ground against ledger ∪ observedText |
| plan advances on ungrounded mid-plan prose | grounding gate applied at the `:224` advance path |
| evaluator response truncated / no fact | fact field optional + salvage-safe; skip with no entry |
| ledger unbounded growth | cap ≤ 24 entries / ~4 K chars, dedup, drop oldest |

## Capture approach — chosen vs rejected

- **Chosen: evaluator-emitted facts.** Reuses an existing grounded LLM call that already runs on step-completion and reads the page; nothing new for the 4B to remember to call.
- *Rejected — `record_fact` tool:* a 4B unreliably remembers to call it, and it grows the tool catalog (token cost + misuse surface).
- *Deferred backstop — deterministic snippet capture:* no LLM, but crude extraction. Available later if evaluator capture proves too sparse.

## Context window — configurable, staged, hardware-gated (Phase 2)

Long-horizon tasks benefit from a larger window *in addition to* the ledger (the ledger fixes fact-retention at any window size; a bigger window gives it headroom before any cap bites). gemma4:e4b supports up to 131072 (`budget.ts:9`), and its sliding-window attention keeps the KV cache far below a naive transformer's. But the target box is 16 GB and `budget.ts:9` warns: *"if KV alloc exceeds VRAM, e4b fails to load and every task breaks."* This sandbox cannot reach Ollama, so VRAM headroom **must be verified by the user on the box** with `ollama ps` — it cannot be measured here.

Therefore the window raise is **configurable and reversible**, not a hardcoded bump:

- `NUM_CTX` becomes a setting (`settings.numCtx`), **default 32768** (the proven value) — `budget.ts` reads it with that fallback.
- Per-role `BUDGETS` and the raw page/observed caps **derive from `numCtx`** (proportional), so raising the window scales the curated window coherently. `COMPACT_TRIGGER_FRAC` (0.8) is unchanged.
- The user escalates **32K → 64K → 128K**, verifying each with `ollama ps` (model stays ~100% GPU, no CPU spill, a real long task completes). If a level won't load or spills, the setting reverts instantly — no rebuild.
- Ships **after** the ledger. The ledger carries zero hardware risk; the window change defaults to today's behavior until the user opts up.

## Explicitly NOT changing (intentional prior decisions)

- **Page content stays last in the prompt** (`prompts/index.ts:141-143`) — a deliberate recency placement (the carry-forward fix). Not reordered.
- **`num_ctx` default stays 32768** — only the *ceiling* becomes user-raisable; the proven default is untouched until the user verifies headroom.
- **Compaction trigger fraction is not lowered** — the ledger sidesteps the need for lossy 4B summarization.
- The lower-tier audit items (semantic tool-arg retry, table-aware truncation, bigger recent-actions window, `overBudget` enforcement) are **out of scope** for this pass.

## Components & isolation

- **evaluator role** (`roles/evaluator.ts`, `prompts/index.ts` evaluator builder): add optional `fact` to the output contract; parse + salvage like `verdict`.
- **orchestrator** (`orchestrator.ts`): own `this.facts`; capture+ground+store on the advance path; render into `commonCtx`; rehydrate on resume; apply the grounding gate to the `:224` prose-advance.
- **grounding** (`verify/grounding.ts`): reuse `ungroundedNumbers`; extend the finish check to consult the ledger.
- **state_store** (`state_store.ts`): `addFinding` / `getFindings` already exist — used as-is.
- **prompts** (`prompts/index.ts`): `FINDINGS:` slot already exists — only `findingsBlock` population changes.

Each unit is independently testable: ledger render/cap/dedup is pure; grounding is pure; evaluator parsing is unit-level; the advance-path gate is integration-level.

## Testing (TDD)

- Ledger: render format, cap at 24 / ~4 K chars, dedup near-identical facts.
- Fact grounding-gate: a fact with an ungrounded number is not stored; a grounded one is.
- Evaluator: `fact` parsed from clean JSON; salvaged/absent from a truncated response → no entry.
- Resume: rehydrate `this.facts` from persisted findings.
- Integration: a 6-item comparison retains all 6 facts at the synthesis turn; an ungrounded mid-plan prose answer is blocked from advancing the plan.
- Budget scaling: `BUDGETS` + page/observed caps derive correctly from `numCtx` (32768 default unchanged; a larger window scales them proportionally); unset/invalid `numCtx` falls back to 32768.

## Implementation notes

TDD, branch per change, ff-merge. No new tools, no new model role, no catalog growth. Sequenced: ledger + grounding (Phase 1, no hardware risk) → configurable window (Phase 2, defaults to today's 32K). The change is additive: if every new path no-ops and `numCtx` stays default, the agent behaves exactly as today.
