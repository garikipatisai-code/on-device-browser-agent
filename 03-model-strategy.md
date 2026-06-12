# 03 — Model Strategy

## The golden rule

**Local-first by default. Cloud is an opt-in per-role upgrade, off by default.**

Full agent functionality requires zero cloud configuration. Every role has a
local model assignment that works. Cloud API keys unlock optional quality
upgrades per role — but nothing breaks without them.

## Current model lineup (June 2026)

### Local (Ollama — free, private, always available)

| Model | Size | VRAM | Speed | Best for |
|-------|------|------|-------|----------|
| `gemma4:2b` | 2B params | ~1.5 GB | ~60 tok/s | Hot-path Executor, Compactor |
| `gemma4:4b` | 4B params | ~3 GB | ~30 tok/s | Evaluator (balanced) |
| `gemma4:26b` | 26B params | CPU/RAM | ~5-10 tok/s | Planner (quality reasoning) |

**Hardware context (baseline):** P2200 5 GB VRAM, 32 GB DDR4, i7.
- 2B + 4B models co-reside in VRAM
- 26B spills to CPU/RAM (still usable for occasional Planner calls)
- Ollama 0.30.4+ required (flash-attention fix for Gemma 4)

**Ollama configuration (critical):**
```
OLLAMA_ORIGINS="chrome-extension://*"   # Chrome extension CORS
OLLAMA_FLASH_ATTENTION=1                # Enable for 4B/26B
OLLAMA_KV_CACHE_TYPE=q4_0              # Quantized KV cache
OLLAMA_MAX_LOADED_MODELS=2             # Prevent swap-thrash
```

### Cloud (BYOK — opt-in quality upgrade)

| Provider | Model | Use for |
|----------|-------|---------|
| DeepSeek | `deepseek-v4-pro` | Planner upgrade (200K context) |
| DeepSeek | `deepseek-v4-flash` | Executor upgrade (fast API) |
| Anthropic | Claude Sonnet 4.6 | Evaluator upgrade (best reasoning) |

Cloud routing is per-role: you can run Planner on DeepSeek while Executor
stays local. Auto-fallback to local on cloud error/timeout.

## Per-role model assignment

### Planner — quality over speed

**Job:** Decompose goal into steps. Make strategic decisions. Replan when stuck.
**Thinking mode:** ON (needs to reason about approach)
**Context budget:** ≤32K tokens
**Frequency:** Once at start, then only on replan (rare)
**Latency tolerance:** Up to 5 minutes (rare call, quality matters)
**Default model:** `gemma4:26b` (local)
**Cloud upgrade:** DeepSeek V4 Pro (200K context for complex goals)

### Executor — speed over quality

**Job:** Read current page. Choose tool. Call tool. Report result. Repeat.
**Thinking mode:** OFF (should act, not deliberate)
**Context budget:** ≤6K tokens (hard limit for interactive feel)
**Frequency:** Every turn (hot path)
**Latency tolerance:** ≤6 seconds (feels broken if slower)
**Default model:** `gemma4:2b` (fastest local)
**Cloud upgrade:** DeepSeek V4 Flash (if 2B isn't reliable enough)

### Evaluator — accuracy over speed

**Job:** Did the step achieve its intent? Produce verdict + evidence.
**Thinking mode:** ON (needs to compare actual vs expected)
**Context budget:** ≤8K tokens
**Frequency:** After every step (every ~3-5 Executor turns)
**Latency tolerance:** Up to 2 minutes
**Default model:** `gemma4:4b` (balanced speed/quality)
**Cloud upgrade:** Claude Sonnet 4.6 (best judgment)

### Compactor — fast and reliable

**Job:** Summarize findings. Archive to IndexedDB. Truncate scratchpad.
**Thinking mode:** OFF
**Context budget:** ≤6K tokens
**Frequency:** When Executor context nears budget
**Default model:** `gemma4:2b` (same as Executor)
**Cloud upgrade:** None (compaction is always local — PII stays on device)

## Embedding model

**`mxbai-embed-large`** (335M params, 1024-dim, MTEB Overall 64.68)
- Fast (~2.9s per embedding on P2200)
- Strong retrieval quality for search and memory lookups
- Configurable via settings for future swaps

**Rejected:** `qwen3-embedding:0.6b` (~60 MTEB, measurably weaker)
**Deferred:** Reranker models — our N=10 retrieval workload doesn't have the
recall gap a cross-encoder exists to fill. Measure before adding.

## Model migration history (for context)

The project has lived through several model generations:

1. **Qwen 3.5 (4B + 35B)** — Initial lineup. 35B was a strong Planner but
   Hermes-JSON parser mismatch caused tool-call failures.
2. **Gemma 4 (2B + 4B + 26B)** — Current. Better tool-call reliability.
   Required Ollama upgrade from 0.22.1 → 0.30.4 for flash-attention fix.

**Lesson:** Tool-call format compatibility is the #1 model selection criterion.
A model that can produce valid `tool_calls` 90%+ of the time beats a smarter
model that only gets it right 50% of the time. Always smoke-test tool-call
reliability before adopting a new model.

## Structured output modes

| Mode | Status | Use |
|------|--------|-----|
| Tool calls (`tool_choice: "auto"`) | ~80-90% reliable on 2B/4B | Primary output channel |
| `format: "json"` (string mode) | ✅ Reliable | Free-form JSON when tool schema doesn't fit |
| `format: <schema-object>` | ❌ BROKEN on Qwen, untested on Gemma | Never use |

**Critical rule:** Never pass a JSON Schema object as the `format` parameter.
It's confirmed broken across multiple Ollama models. Use `format: "json"` for
string-mode JSON output, or tool calls for structured output. If you need
schema validation, do it post-hoc with Zod.

## Prompt format

Use the **chat template format** for each model. For Gemma/Ollama:

```
[system, user-anchor]          ← First call
[system, user-anchor, assistant-failed, user-nudge]  ← Retry
```

**Never use `[system, system-nudge]`** — Qwen's chat template only emits one
`<|im_start|>system` block; extras are inlined or dropped. Gemma may behave
differently but the two-message pattern is the safe default.

The `user-anchor` message contains the frozen goal, plan, and rules. It's
identical across all turns within a task — enabling KV-cache reuse.
Put stable content first (goal, tools, rules), churn content last
(findings, scratchpad, recent actions).

## KV-cache optimization

Arrange prompt sections for cache reuse:
1. **Stable prefix** (goal, tool definitions, rules) — cached across turns
2. **Semi-stable** (plan, current step) — cached within a step
3. **Churn** (findings, scratchpad, recent actions) — changes every turn

This ordering gives the Executor ~50% `prompt_eval_duration` reduction when
Ollama's `cache_prompt: true` is active (enabled by default in 0.30.4).
