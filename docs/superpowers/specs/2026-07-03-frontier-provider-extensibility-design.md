# Frontier provider extensibility + thinking control

**Date:** 2026-07-03
**Status:** Approved (conversation)

## Problem

The agent-framework-model-tiering work (2026-07-02) shipped a frontier "lead seat" (head-chef/sous-chef) that can optionally run on Claude via Anthropic's API, with local Ollama as the always-available default and fallback. Two gaps surfaced in practice:

1. **The frontier config is hardcoded to Anthropic specifically.** `provider: 'anthropic'` is a single-value literal type, and `frontierProvider`'s request URL is an unexported constant (`ANTHROPIC_API_URL`). There's no way to point the lead seat at any other model provider — OpenAI itself, Azure OpenAI, OpenRouter, self-hosted vLLM/llama.cpp, or anything else — without editing source.
2. **`frontierProvider` silently drops the `thinking` signal.** Every role already carries a generic `thinking: boolean` field on `ChatOptions` (planner/evaluator/executor pass `true`; compactor passes `false`), and local Ollama already respects it (translates to its own `think` field). But `frontierProvider` hardcodes `thinking: {type: 'adaptive'}` unconditionally, ignoring whatever the caller actually passed. There's also no user-facing way to override thinking behavior for the lead seat without editing source.

## Principle

Same evolutionary approach as the parent spec: extend the existing `ModelProvider`/`FrontierConfig` shapes rather than rebuild them. Cover the broadest set of non-Anthropic providers with the single most-leveraged addition — a generic OpenAI-compatible provider (base URL + Bearer auth + Chat Completions shape) — rather than hardcoding a new named provider per vendor. Fix the thinking gap the same way `withFallback` already composes behavior: a small provider-wrapping function, not a rewrite of the role or provider layers.

**Concretely, this one addition covers the actual set of providers in scope:** OpenAI directly, OpenRouter (aggregates open-source models behind an OpenAI-shaped endpoint), and DeepSeek/MiniMax's own direct APIs — all of these publish an OpenAI Chat Completions-compatible endpoint, so all of them are just "pick `openai-compatible`, set `baseUrl` and `model`," never a new provider function. Anthropic keeps its own dedicated `frontierProvider` since its request/response shape is genuinely different (content blocks, `x-api-key` header, top-level `system` field).

## Design

### Config shape (`shared/messages.ts`)

`Settings['frontier']` becomes a discriminated union instead of one flat Anthropic-shaped object:

```ts
export type FrontierConfig =
  | { provider: 'anthropic'; apiKey: string; model: string }
  | { provider: 'openai-compatible'; apiKey: string; model: string; baseUrl: string };

// Settings additions:
frontier?: FrontierConfig;
leadThinking?: boolean;   // undefined = unchanged default (today's hardcoded per-role values apply)
```

`agent/framework/provider.ts`'s existing `export type FrontierConfig = NonNullable<Settings['frontier']>` is unchanged — it keeps deriving from `Settings`, not duplicating, and automatically inherits the union.

**Backward compatible for free:** a persisted `{provider:'anthropic', apiKey, model}` record already matches the union's first arm exactly — no migration code needed.

**Scope stays narrow:** this only changes the shape of frontier config and adds one new override. The one-master-`hybridMode`-toggle-covers-both-seats decision from the parent spec is untouched — still no per-seat provider choice.

### New provider: `openAICompatibleProvider` (`agent/framework/provider.ts`)

Sibling function to the existing `frontierProvider`, in the same file (module grows to ~220 lines, still one clear "frontier backends" responsibility — splitting into per-provider files would be premature at this size).

```ts
function openAICompatibleProvider(cfg: Extract<FrontierConfig, { provider: 'openai-compatible' }>): ModelProvider {
  return {
    async chatOnce(opts: ChatOptions): Promise<ChatResponse> {
      const body: Record<string, unknown> = {
        model: cfg.model,
        max_tokens: 4096,
        messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
      };
      if (opts.thinking === true) body.reasoning_effort = 'high';

      const { signal, cleanup } = composeSignal(opts.timeoutMs ?? 120_000, opts.signal);
      try {
        const res = await fetch(cfg.baseUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify(body),
          signal,
        });
        if (!res.ok) throw frontierHttpError(res.status, await safeText(res));
        return normalizeOpenAIResponse(await res.json());
      } finally {
        cleanup();
      }
    },
  };
}

function normalizeOpenAIResponse(json: Record<string, unknown>): ChatResponse {
  const choice = (json.choices as Array<{ message?: { content?: string; refusal?: string } }> | undefined)?.[0];
  if (choice?.message?.refusal) throw new Error(`Frontier model declined the request (${choice.message.refusal})`);
  const text = choice?.message?.content ?? '';
  const usage = json.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  return {
    message: { role: 'assistant', content: text },
    done: true,
    promptEvalCount: usage?.prompt_tokens,
    evalCount: usage?.completion_tokens,
    toolCalls: [],
    rawText: text,
  };
}
```

Differences from `frontierProvider` (Anthropic), and why each is simpler here:

- **No `splitSystem`.** OpenAI's shape keeps a `role: 'system'` message directly inside the `messages` array — Anthropic is the one needing extraction into a top-level `system` field.
- **`reasoning_effort` sent only when `opts.thinking === true`.** Best-effort: OpenAI's own reasoning models recognize this field; most non-OpenAI "OpenAI-compatible" backends don't. Concretely: DeepSeek's and MiniMax's own APIs, and most OpenRouter-routed open-weight models, will silently ignore it — their reasoning models (if any) either always reason or use a provider-specific control this generic path doesn't attempt to guess. So for those specific providers, "Default" and "Always on" (below) are expected to behave the same. It's still sent for the OpenAI case where it does something, and omitted rather than guessed the rest of the time.
- **DeepSeek/MiniMax-style reasoning models often return a separate `reasoning_content` field alongside `content`** (their chain-of-thought, distinct from the final answer). `normalizeOpenAIResponse` deliberately reads only `content`, never `reasoning_content` — the same "don't surface raw reasoning into observed text" choice `normalizeAnthropicResponse` already makes by filtering to `type === 'text'` blocks only.
- **Reuses `frontierHttpError`/`safeText` unchanged**, so `withFallback`'s 5xx-retry-then-fallback logic works identically for both providers with zero changes to `withFallback` itself.
- **Refusal surfaces via `choices[0].message.refusal`** (present on some models/backends for safety-declined requests) rather than a `stop_reason` field.

`resolveLeadProvider` gains a one-line dispatch to pick the right provider function:

```ts
function frontierProviderFor(cfg: FrontierConfig): ModelProvider {
  return cfg.provider === 'anthropic' ? frontierProvider(cfg) : openAICompatibleProvider(cfg);
}
```

### `frontierProvider` fix: honor `opts.thinking`

Currently hardcodes `thinking: {type: 'adaptive'}` unconditionally, ignoring the caller's `opts.thinking`. Fixed to:

```ts
thinking: { type: opts.thinking === false ? 'disabled' : 'adaptive' },
```

`undefined` and `true` both mean "adaptive" — this preserves today's actual behavior for the two seats that currently reach this path (planner and evaluator both already pass `thinking: true`), while making `false` (compactor's own value, and now anything an explicit override sends) actually take effect if this path is ever reached with it.

### Thinking override (`agent/framework/provider.ts`)

```ts
function withThinkingOverride(provider: ModelProvider, override?: boolean): ModelProvider {
  if (override === undefined) return provider; // no-op — today's per-role hardcoded defaults stand
  return {
    async chatOnce(opts: ChatOptions): Promise<ChatResponse> {
      return provider.chatOnce({ ...opts, thinking: override });
    },
  };
}
```

Composed once inside `resolveLeadProvider`, wrapping whichever backend it resolves to — local, Anthropic, or openai-compatible — so the override is provider-agnostic by construction, not by convention. Scoped to the lead seat only: executor and compactor never call through `resolveLeadProvider` and are untouched by this setting.

```ts
export function resolveLeadProvider(
  settings: Settings,
  ollama: OllamaClient,
  onFallback?: (reason: string) => void,
): ModelProvider {
  const base = !settings.hybridMode || !settings.frontier?.apiKey
    ? localProvider(ollama)
    : withFallback(frontierProviderFor(settings.frontier), localProvider(ollama), onFallback);
  return withThinkingOverride(base, settings.leadThinking);
}
```

### Settings UI (`sidepanel/components/SettingsPanel.tsx`)

Extends the existing "Frontier model (optional)" card — no new card, no new visual pattern:

1. **Provider** `<select>` (Anthropic / OpenAI-compatible) — same idiom as the existing `DomainTier` select, shown when `hybridMode` is on.
2. **Model** — existing field; placeholder adapts to the selected provider (`claude-opus-4-8` vs `gpt-5.1`).
3. **Base URL** — new field, shown only when provider is `openai-compatible`; prefilled with `https://api.openai.com/v1/chat/completions` the first time that provider is selected, fully editable. Field hint lists concrete examples so the field isn't a blank guess: OpenRouter (`https://openrouter.ai/api/v1/chat/completions`), DeepSeek (`https://api.deepseek.com/chat/completions`), MiniMax, or any self-hosted/proxy endpoint.
4. **API key** — existing field; placeholder adapts (`sk-ant-...` vs `sk-...`).
5. **Thinking (lead seat)** `<select>` — `Default (recommended)` / `Always on` / `Always off`, mapping to `leadThinking` `undefined`/`true`/`false`. Placed *outside* the `hybridMode`-conditional block (always visible in the card) since it's meaningful in local-only mode too. Hint text says plainly that this is best-effort on non-Anthropic/non-OpenAI providers (DeepSeek, MiniMax, OpenRouter-routed models, self-hosted) — "Default" and "Always on" may behave identically there, since reasoning control isn't standardized across providers.

Field order (Provider → Model → Base URL → API key) means the form only ever shows fields relevant to the chosen provider — it doesn't grow cluttered as providers are added.

## Trade-off

Same trade-off as the parent spec, extended one step further: pointing the lead seat at a self-hosted or third-party "OpenAI-compatible" endpoint means page content read during evaluation can reach whatever's on the other end of that URL — the user is trusting an arbitrary, self-supplied URL, not a vetted list. No new consent gate is added beyond what already exists for `hybridMode` itself, since the trust decision (turn hybrid mode on at all) is the same one already being made.

## Explicitly NOT doing

- **Azure OpenAI's distinct auth and URL scheme** (`api-key` header instead of `Authorization: Bearer`, deployment-name + `api-version`-query-param URL structure) — genuinely not "OpenAI-compatible" at the transport level; would need its own dedicated provider function if ever wanted.
- **Per-seat provider choice** (head-chef on one provider, sous-chef on another) — still one resolution for both, per the parent spec.
- **Thinking control for executor/compactor** — out of scope; they never reach `resolveLeadProvider`.
- **Validating or allowlisting the user-supplied `baseUrl`** — it's trusted input, same trust boundary as the API key field right next to it.
- **A selectable reasoning-effort level** (low/medium/high) — the Settings toggle is a plain on/off/default; "on" maps to a fixed `reasoning_effort: 'high'` for the openai-compatible path.
- **Meaningful reasoning control on DeepSeek, MiniMax, OpenRouter-routed models, or self-hosted backends.** The thinking toggle only does something real on Anthropic and OpenAI itself; elsewhere it's a no-op by omission, not a broken feature — there's no standardized field to send instead.

## Testing (TDD)

- `openAICompatibleProvider` against a mocked HTTP layer, same style as the existing `frontierProvider` tests: request-shape assertion (URL, Bearer header, body), HTTP-error → throws with `.status` set, refusal-field → throws, `reasoning_effort` present only when `opts.thinking === true`.
- `frontierProvider`: new test asserting `thinking: {type: 'disabled'}` is sent when `opts.thinking === false`, and `'adaptive'` otherwise (undefined or true) — closes the gap directly.
- `withThinkingOverride`: passthrough when `override === undefined` (same provider instance/behavior); forces `opts.thinking` otherwise, verified via a fake provider capturing the `opts` it actually received.
- `resolveLeadProvider`: extend existing tests to cover the `openai-compatible` branch, and confirm `leadThinking` composes correctly on top of both the local and frontier branches.
- One explicit regression test: `leadThinking: undefined` + `hybridMode: false` behaves identically to the pre-this-spec baseline (reuse the existing `scripted_e2e.test.ts` assertions, matching the parent spec's own regression-test pattern).

## Implementation notes

Touches only `agent/framework/provider.ts` (new function + fix + wrapper), `shared/messages.ts` (`FrontierConfig` union, `leadThinking` field), `sidepanel/components/SettingsPanel.tsx` (provider select, base URL field, thinking select). No changes to `orchestrator.ts`, `roles/*.ts`, or the safety layer. Smaller and more contained than the parent spec — no new files needed.
