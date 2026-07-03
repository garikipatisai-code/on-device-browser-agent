// The seam every seat (head chef, sous chef, helper) calls through — lets a
// seat's model backend be swapped without the seat's own code knowing.
import type { ChatOptions, ChatResponse, OllamaClient } from '@/background/ollama';
import type { FrontierConfig, Settings } from '@/shared/messages';
import { composeSignal } from '@/background/signal';

export interface ModelProvider {
  chatOnce(opts: ChatOptions): Promise<ChatResponse>;
}

// OllamaClient already structurally satisfies ModelProvider (it has chatOnce
// with this exact shape) — this is an identity function, kept as a named,
// self-documenting call site rather than passing the client bare.
export function localProvider(ollama: OllamaClient): ModelProvider {
  return ollama;
}

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// FrontierConfig is defined in shared/messages.ts (the Settings UI needs it
// too) — re-exported here so existing importers of provider.ts's own
// FrontierConfig keep working unchanged.
export type { FrontierConfig };

/** Raw fetch against the Anthropic Messages API — no SDK dependency, matching
 *  OllamaClient's own pattern. Only ever called for the head-chef/sous-chef
 *  seats (planner, evaluator), which never pass `tools` or multi-turn
 *  tool_result history — so this only needs to translate a single system
 *  message + a run of user/assistant messages. If a future frontier-eligible
 *  seat needs tool-calling, this needs the full tool_use/tool_result mapping,
 *  deliberately not built here. */
export function frontierProvider(cfg: Extract<FrontierConfig, { provider: 'anthropic' }>): ModelProvider {
  return {
    async chatOnce(opts: ChatOptions): Promise<ChatResponse> {
      const { system, messages } = splitSystem(opts.messages);
      const body: Record<string, unknown> = {
        model: cfg.model,
        max_tokens: 4096,
        messages,
        thinking: { type: opts.thinking === false ? 'disabled' : 'adaptive' },
      };
      if (system) body.system = system;

      const { signal, cleanup } = composeSignal(opts.timeoutMs ?? 120_000, opts.signal);
      try {
        const res = await fetch(ANTHROPIC_API_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': cfg.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify(body),
          signal,
        });
        if (!res.ok) throw frontierHttpError(res.status, await safeText(res));
        return normalizeAnthropicResponse(await res.json());
      } finally {
        cleanup();
      }
    },
  };
}

function splitSystem(messages: ChatOptions['messages']): { system?: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> } {
  const sys = messages.find((m) => m.role === 'system');
  const rest = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  return { system: sys?.content, messages: rest };
}

function normalizeAnthropicResponse(json: Record<string, unknown>): ChatResponse {
  if (json.stop_reason === 'refusal') {
    const category = (json.stop_details as { category?: string } | undefined)?.category ?? 'refusal';
    throw new Error(`Frontier model declined the request (${category})`);
  }
  const blocks = (json.content as Array<{ type: string; text?: string }> | undefined) ?? [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  const usage = json.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  return {
    message: { role: 'assistant', content: text },
    done: true,
    promptEvalCount: usage?.input_tokens,
    evalCount: usage?.output_tokens,
    toolCalls: [],
    rawText: text,
  };
}

function frontierHttpError(status: number, body: string): Error & { status: number } {
  const err = new Error(`Frontier HTTP ${status}: ${body.slice(0, 256)}`) as Error & { status: number };
  err.status = status;
  return err;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

export function openAICompatibleProvider(cfg: Extract<FrontierConfig, { provider: 'openai-compatible' }>): ModelProvider {
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

/** Composes at the resolution layer so runHeadChef/runSousChef stay unaware
 *  fallback exists — they just call provider.chatOnce(). One retry on a
 *  retryable error (5xx — matches OllamaClient.withRetry); no retry on a
 *  non-retryable error (4xx, or a thrown refusal) since retrying won't help.
 *  Either way, falls back to `fallback` and reports why via onFallback. */
export function withFallback(
  primary: ModelProvider,
  fallback: ModelProvider,
  onFallback?: (reason: string) => void,
): ModelProvider {
  return {
    async chatOnce(opts: ChatOptions): Promise<ChatResponse> {
      try {
        return await primary.chatOnce(opts);
      } catch (err) {
        if (isRetryableFrontierError(err)) {
          try {
            return await primary.chatOnce(opts);
          } catch (retryErr) {
            onFallback?.(describeFallbackReason(retryErr));
            return fallback.chatOnce(opts);
          }
        }
        onFallback?.(describeFallbackReason(err));
        return fallback.chatOnce(opts);
      }
    },
  };
}

function isRetryableFrontierError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const status = (err as { status?: number }).status;
  return typeof status === 'number' && status >= 500 && status < 600;
}

function describeFallbackReason(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown frontier error';
}

export function withThinkingOverride(provider: ModelProvider, override?: boolean): ModelProvider {
  if (override === undefined) return provider; // no-op — today's per-role hardcoded defaults stand
  return {
    async chatOnce(opts: ChatOptions): Promise<ChatResponse> {
      return provider.chatOnce({ ...opts, thinking: override });
    },
  };
}

function frontierProviderFor(cfg: FrontierConfig): ModelProvider {
  return cfg.provider === 'anthropic' ? frontierProvider(cfg) : openAICompatibleProvider(cfg);
}

/** Resolved once per run for the head-chef and sous-chef seats — they always
 *  resolve identically, since hybridMode is one master toggle, not two
 *  independent ones. Falls out to local whenever hybrid mode is off or no
 *  frontier config is present: this IS the "local-only is the unchanged
 *  default" guarantee, not a promise layered on top of it. */
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
