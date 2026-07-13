// Shared helpers for tests.
import type { ChatMessage, ChatOptions, ChatResponse, OllamaClient } from '@/background/ollama';
import { _testing as stateStoreTesting } from '@/background/state_store';

export function rawResponse(opts: {
  content?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  promptEvalCount?: number;
  evalCount?: number;
}): ChatResponse {
  const message: ChatMessage = {
    role: 'assistant',
    content: opts.content ?? '',
    ...(opts.toolCalls && opts.toolCalls.length
      ? {
          tool_calls: opts.toolCalls.map((c) => ({
            type: 'function' as const,
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        }
      : {}),
  };
  return {
    message,
    done: true,
    toolCalls: opts.toolCalls ?? [],
    rawText: opts.content ?? '',
    promptEvalCount: opts.promptEvalCount,
    evalCount: opts.evalCount,
  };
}

export function makeFakeOllama(
  queues: Record<string, ChatResponse[]>,
  options: { onChat?: (model: string, role: string, messages: ChatMessage[], toolNames: string[]) => void } = {},
): OllamaClient {
  // Anchor on "You are the <ROLE>" so the executor's prompt (which mentions
  // "the Evaluator will judge") doesn't get misclassified as an evaluator call.
  const detect = (messages: ChatMessage[]): string => {
    const sys = messages.find((m) => m.role === 'system')?.content ?? '';
    if (/You are the PLANNER/i.test(sys)) return 'planner';
    if (/You are the EVALUATOR/i.test(sys)) return 'evaluator';
    if (/You are the COMPACTOR/i.test(sys)) return 'compactor';
    if (/You are the EXECUTOR/i.test(sys)) return 'executor';
    return 'unknown';
  };
  const next = (role: string): ChatResponse => {
    const q = queues[role];
    if (!q || q.length === 0) {
      return rawResponse({ content: '{}' });
    }
    return q.shift()!;
  };
  return {
    baseUrl: 'http://fake',
    setBaseUrl: () => undefined,
    ping: async () => true,
    listModels: async () => ['gemma4:e4b', 'gemma4:4b', 'gemma4:26b', 'mxbai-embed-large'],
    chatOnce: async (opts: ChatOptions) => {
      const role = detect(opts.messages);
      options.onChat?.(opts.model, role, opts.messages, (opts.tools ?? []).map((t) => t.function.name));
      return next(role);
    },
    chatStream: async function* (opts: ChatOptions) {
      const role = detect(opts.messages);
      options.onChat?.(opts.model, role, opts.messages, (opts.tools ?? []).map((t) => t.function.name));
      yield next(role);
    },
    embed: async () => [0, 0, 0],
  } as unknown as OllamaClient;
}

export async function resetStorage(): Promise<void> {
  (globalThis as { __resetTestStorage?: () => void }).__resetTestStorage?.();
  await stateStoreTesting._resetDb();
}
