// The seam every seat (head chef, sous chef, helper) calls through — lets a
// seat's model backend be swapped without the seat's own code knowing.
import type { ChatOptions, ChatResponse, OllamaClient } from '@/background/ollama';
import type { Settings } from '@/shared/messages';
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

// Reuse Settings['frontier'] rather than defining a second, structurally-identical
// interface — provider.ts already imports Settings for resolveLeadProvider below.
export type FrontierConfig = NonNullable<Settings['frontier']>;

/** Raw fetch against the Anthropic Messages API — no SDK dependency, matching
 *  OllamaClient's own pattern. Only ever called for the head-chef/sous-chef
 *  seats (planner, evaluator), which never pass `tools` or multi-turn
 *  tool_result history — so this only needs to translate a single system
 *  message + a run of user/assistant messages. If a future frontier-eligible
 *  seat needs tool-calling, this needs the full tool_use/tool_result mapping,
 *  deliberately not built here. */
export function frontierProvider(cfg: FrontierConfig): ModelProvider {
  return {
    async chatOnce(opts: ChatOptions): Promise<ChatResponse> {
      const { system, messages } = splitSystem(opts.messages);
      const body: Record<string, unknown> = {
        model: cfg.model,
        max_tokens: 4096,
        messages,
        thinking: { type: 'adaptive' },
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
  const err = new Error(`Anthropic HTTP ${status}: ${body.slice(0, 256)}`) as Error & { status: number };
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
  if (!settings.hybridMode || !settings.frontier?.apiKey) return localProvider(ollama);
  return withFallback(frontierProvider(settings.frontier), localProvider(ollama), onFallback);
}
