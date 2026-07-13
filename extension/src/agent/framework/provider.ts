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

// Frontier APIs (OpenAI, Anthropic) restrict tool names to [a-zA-Z0-9_-].
// Our tools use dots (tab.click, dom.query, page.fetch, vision.read, etc.) which
// are rejected. Build a map of sanitized→original names so we can map back in
// the response without corrupting tools that already use underscores (open_result,
// next_step, tab_read_active, etc.).
function buildToolNameMap(tools: ChatOptions['tools']): Map<string, string> {
  const m = new Map<string, string>();
  if (!tools) return m;
  for (const t of tools) {
    const sanitized = t.function.name.replace(/\./g, '_');
    if (sanitized !== t.function.name) m.set(sanitized, t.function.name);
  }
  return m;
}

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// FrontierConfig is defined in shared/messages.ts (the Settings UI needs it
// too) — re-exported here so existing importers of provider.ts's own
// FrontierConfig keep working unchanged.
export type { FrontierConfig };

/** Raw fetch against the Anthropic Messages API — handles tool calls when
 *  the caller passes `tools`, otherwise text-only. */
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
      // Anthropic tool format: {name, description, input_schema}
      const nameMap = buildToolNameMap(opts.tools);
      if (opts.tools && opts.tools.length > 0) {
        body.tools = opts.tools.map((t) => ({
          name: nameMap.has(t.function.name) ? nameMap.get(t.function.name)! : t.function.name.replace(/\./g, '_'),
          description: t.function.description,
          input_schema: t.function.parameters,
        }));
      }

      const { signal, cleanup } = composeSignal(opts.timeoutMs ?? 300_000, opts.signal);
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
        return normalizeAnthropicResponse(await res.json(), nameMap);
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

function normalizeAnthropicResponse(json: Record<string, unknown>, nameMap?: Map<string, string>): ChatResponse {
  if (json.stop_reason === 'refusal') {
    const category = (json.stop_details as { category?: string } | undefined)?.category ?? 'refusal';
    throw new Error(`Frontier model declined the request (${category})`);
  }
  const blocks = (json.content as Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }> | undefined) ?? [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  // Extract tool_use blocks — Anthropic returns tools alongside text in the content array
  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = blocks
    .filter((b): b is { type: 'tool_use'; name: string; input: Record<string, unknown> } & typeof b => b.type === 'tool_use')
    .map((b) => ({ name: nameMap?.get(b.name) ?? b.name, args: b.input ?? {} }));
  if (!text && toolCalls.length === 0) throw new Error('Frontier model returned no text or tool call content');
  const rawText = toolCalls.length > 0 ? toolCalls.map((t) => `${t.name}(${JSON.stringify(t.args)})`).join('\n') : text;
  const usage = json.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  return {
    message: { role: 'assistant', content: text || rawText },
    done: true,
    promptEvalCount: usage?.input_tokens,
    evalCount: usage?.output_tokens,
    toolCalls,
    rawText,
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
      if (opts.thinking === true) body.reasoning_effort = opts.thinkingEffort ?? 'medium';
      const nameMap = buildToolNameMap(opts.tools);
      if (opts.tools && opts.tools.length > 0) {
        body.tools = opts.tools.map((t) => ({
          type: 'function',
          function: { name: nameMap.has(t.function.name) ? nameMap.get(t.function.name)! : t.function.name.replace(/\./g, '_'), description: t.function.description, parameters: t.function.parameters },
        }));
      }

      const { signal, cleanup } = composeSignal(opts.timeoutMs ?? 300_000, opts.signal);
      try {
        const res = await fetch(cfg.baseUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify(body),
          signal,
        });
        if (!res.ok) throw frontierHttpError(res.status, await safeText(res));
        return normalizeOpenAIResponse(await res.json(), nameMap);
      } finally {
        cleanup();
      }
    },
  };
}

function normalizeOpenAIResponse(json: Record<string, unknown>, nameMap?: Map<string, string>): ChatResponse {
  type Choice = { message?: { content?: string; refusal?: string; tool_calls?: Array<{ function: { name: string; arguments: string } }> } };
  const choice = (json.choices as Choice[] | undefined)?.[0];
  if (choice?.message?.refusal) throw new Error(`Frontier model declined the request (${choice.message.refusal})`);
  const text = choice?.message?.content ?? '';
  // Extract tool calls — OpenAI returns them as a separate array on the message
  const rawToolCalls = choice?.message?.tool_calls ?? [];
  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = rawToolCalls.map((tc) => ({
    name: nameMap?.has(tc.function.name) ? nameMap.get(tc.function.name)! : tc.function.name,
    args: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })(),
  }));
  if (!text && toolCalls.length === 0) throw new Error('Frontier model returned no text or tool call content');
  const rawText = toolCalls.length > 0 ? toolCalls.map((t) => `${t.name}(${JSON.stringify(t.args)})`).join('\n') : text;
  const usage = json.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  return {
    message: { role: 'assistant', content: text || rawText },
    done: true,
    promptEvalCount: usage?.prompt_tokens,
    evalCount: usage?.completion_tokens,
    toolCalls,
    rawText,
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

export function withThinkingOverride(provider: ModelProvider, override?: boolean, effort?: 'low' | 'medium' | 'high'): ModelProvider {
  if (override === undefined) return provider; // no-op — today's per-role hardcoded defaults stand
  return {
    async chatOnce(opts: ChatOptions): Promise<ChatResponse> {
      return provider.chatOnce({ ...opts, thinking: override, thinkingEffort: effort ?? opts.thinkingEffort });
    },
  };
}

function frontierProviderFor(cfg: FrontierConfig): ModelProvider {
  return cfg.provider === 'anthropic' ? frontierProvider(cfg) : openAICompatibleProvider(cfg);
}

/** Resolve a ModelProvider from a RoleGroupConfig. For ollama provider, returns
 *  the local Ollama client directly. For frontier providers, wraps in withFallback
 *  (one retry on 5xx, then falls back to local). Applies thinkingLevel as an
 *  override — maps to provider-native params (budget_tokens for Anthropic,
 *  reasoning_effort for OpenAI-compatible, ignored for Ollama). */
export function resolveProvider(
  group: { provider: string; model: string; apiKey?: string; baseUrl?: string; thinkingLevel?: string },
  ollama: OllamaClient,
  onFallback?: (reason: string) => void,
): ModelProvider {
  if (group.provider === 'ollama') {
    return withThinkingOverride(
      localProvider(ollama),
      group.thinkingLevel && group.thinkingLevel !== 'off' ? thinkingLevelToEffort(group.thinkingLevel).thinking : undefined,
      thinkingLevelToEffort(group.thinkingLevel ?? 'off').effort,
    );
  }
  const cfg: FrontierConfig = group.provider === 'anthropic'
    ? { provider: 'anthropic', apiKey: group.apiKey!, model: group.model }
    : { provider: 'openai-compatible', apiKey: group.apiKey!, model: group.model, baseUrl: group.baseUrl! };
  const base = withFallback(frontierProviderFor(cfg), localProvider(ollama), onFallback);
  const { thinking, effort } = thinkingLevelToEffort(group.thinkingLevel ?? 'off');
  return withThinkingOverride(base, thinking, effort);
}

function thinkingLevelToEffort(level: string): { thinking?: boolean; effort?: 'low' | 'medium' | 'high' } {
  if (level === 'off') return {};
  if (level === 'fast') return { thinking: true, effort: 'low' };
  if (level === 'standard') return { thinking: true, effort: 'medium' };
  return { thinking: true, effort: 'high' }; // 'full'
}
