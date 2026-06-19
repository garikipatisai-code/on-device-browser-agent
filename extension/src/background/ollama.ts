// Ollama HTTP client.
// - Raw fetch() — no SDK dependency
// - keep_alive: '10m' on every chat call
// - composeSignal() with mandatory cleanup() in finally
// - One retry on transient HTTP 5xx and network errors
// - Pre-flight ping before tasks (fail fast on wrong URL)

import { composeSignal } from './signal';

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Base64-encoded images (no data: prefix) for multimodal models like gemma4. */
  images?: string[];
  tool_calls?: Array<{
    id?: string;
    type?: 'function';
    function: { name: string; arguments: string | Record<string, unknown> };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?: 'auto' | 'none' | 'required';
  thinking?: boolean;
  format?: 'json'; // never pass a schema object — see blueprint §03
  temperature?: number;
  topP?: number;
  topK?: number;
  numCtx?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  keepAlive?: string;
  cachePrompt?: boolean;
}

export interface ChatResponse {
  message: ChatMessage;
  done: boolean;
  totalDuration?: number;
  promptEvalCount?: number;
  evalCount?: number;
  promptEvalDuration?: number;
  evalDuration?: number;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  rawText: string;
}

export interface EmbedOptions {
  model: string;
  input: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class OllamaClient {
  constructor(public baseUrl: string = 'http://localhost:11434') {}

  setBaseUrl(url: string) {
    this.baseUrl = url.replace(/\/$/, '');
  }

  async ping(timeoutMs = 1500): Promise<boolean> {
    const { signal, cleanup } = composeSignal(timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      cleanup();
    }
  }

  async listModels(timeoutMs = 4000): Promise<string[]> {
    const { signal, cleanup } = composeSignal(timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal });
      if (!res.ok) return [];
      const body = (await res.json()) as { models?: Array<{ name: string }> };
      return (body.models ?? []).map((m) => m.name);
    } catch {
      return []; // network error / bad body → treat as "no models reachable", not a throw
    } finally {
      cleanup();
    }
  }

  async chatOnce(opts: ChatOptions): Promise<ChatResponse> {
    const body = this.buildBody(opts, /*stream*/ false);
    return this.withRetry(async () => {
      const { signal, cleanup } = composeSignal(opts.timeoutMs ?? 120_000, opts.signal);
      try {
        const res = await fetch(`${this.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        });
        if (!res.ok) throw httpError(res.status, await safeText(res));
        const json = await res.json();
        return normalizeChat(json);
      } finally {
        cleanup();
      }
    });
  }

  async *chatStream(opts: ChatOptions): AsyncGenerator<ChatResponse> {
    const body = this.buildBody(opts, /*stream*/ true);
    const { signal, cleanup } = composeSignal(opts.timeoutMs ?? 120_000, opts.signal);
    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) throw httpError(res.status, await safeText(res));
      const reader = res.body?.getReader();
      if (!reader) throw new Error('Ollama stream: no response body');
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          try {
            const json = JSON.parse(t);
            yield normalizeChat(json);
          } catch {
            /* tolerate partial lines */
          }
        }
      }
      if (buf.trim()) {
        try {
          yield normalizeChat(JSON.parse(buf));
        } catch {
          /* noop */
        }
      }
    } finally {
      cleanup();
    }
  }

  async embed(opts: EmbedOptions): Promise<number[]> {
    const { signal, cleanup } = composeSignal(opts.timeoutMs ?? 20_000, opts.signal);
    try {
      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: opts.model, input: opts.input }),
        signal,
      });
      if (!res.ok) throw httpError(res.status, await safeText(res));
      const body = (await res.json()) as { embeddings?: number[][] };
      const vec = body.embeddings?.[0];
      if (!vec) throw new Error('Ollama embed: missing embeddings[0]');
      return vec;
    } finally {
      cleanup();
    }
  }

  private buildBody(opts: ChatOptions, stream: boolean): Record<string, unknown> {
    // Gemma 4's official sampling defaults (per the model card): temp 1.0,
    // top_p 0.95, top_k 64 — "across all use cases". The model is QAT-tuned
    // for this distribution; forcing temperature 0 degrades it. Callers may
    // still override per-request.
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      stream,
      keep_alive: opts.keepAlive ?? '10m',
      options: {
        temperature: opts.temperature ?? 1.0,
        top_p: opts.topP ?? 0.95,
        top_k: opts.topK ?? 64,
        ...(opts.numCtx ? { num_ctx: opts.numCtx } : {}),
        cache_prompt: opts.cachePrompt !== false,
      },
    };
    if (opts.tools && opts.tools.length) body.tools = opts.tools;
    if (opts.toolChoice) body.tool_choice = opts.toolChoice;
    if (opts.thinking !== undefined) body.think = opts.thinking;
    if (opts.format === 'json') body.format = 'json'; // string mode only
    return body;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err)) throw err;
      // single retry on transient errors (no jitter — fast)
      return fn();
    }
  }
}

function isRetryable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: number; name?: string };
  if (e.status && e.status >= 500 && e.status < 600) return true;
  if (e.name === 'TypeError') return true; // network blip
  // do not retry AbortError / TimeoutError — caller decides
  return false;
}

function httpError(status: number, body: string): Error & { status: number } {
  const err = new Error(`Ollama HTTP ${status}: ${body.slice(0, 256)}`) as Error & { status: number };
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

export function normalizeChat(json: Record<string, unknown>): ChatResponse {
  const message = (json.message as ChatMessage) ?? { role: 'assistant', content: '' };
  const toolCalls = parseToolCalls(message.tool_calls);
  return {
    message,
    done: !!json.done,
    totalDuration: numOrUndef(json.total_duration),
    promptEvalCount: numOrUndef(json.prompt_eval_count),
    evalCount: numOrUndef(json.eval_count),
    promptEvalDuration: numOrUndef(json.prompt_eval_duration),
    evalDuration: numOrUndef(json.eval_duration),
    toolCalls,
    rawText: typeof message.content === 'string' ? message.content : '',
  };
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function parseToolCalls(
  raw: ChatMessage['tool_calls'],
): Array<{ name: string; args: Record<string, unknown> }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ name: string; args: Record<string, unknown> }> = [];
  for (const c of raw) {
    if (!c?.function?.name) continue;
    let args: Record<string, unknown> = {};
    const a = c.function.arguments;
    if (typeof a === 'string') {
      try {
        args = JSON.parse(a) as Record<string, unknown>;
      } catch {
        args = { _raw: a };
      }
    } else if (a && typeof a === 'object') {
      args = a as Record<string, unknown>;
    }
    out.push({ name: c.function.name, args });
  }
  return out;
}
