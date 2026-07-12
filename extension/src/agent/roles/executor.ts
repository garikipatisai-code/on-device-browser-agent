// Executor role: pick ONE tool, dispatch it, return the result for the orchestrator.

import type { ChatMessage, ToolDef } from '@/background/ollama';
import type { ModelProvider } from '../framework/provider';
import type { ToolRegistry } from '../tools/registry';
import type { ToolContext, ToolResult } from '../tools/registry';
import { buildExecutorMessages, buildExecutorRetryMessages, type CommonContext } from '../prompts';
import { NUM_CTX } from '../budget';
import { parseJSONPermissive } from '../util';

export interface ExecutorInput {
  ctx: CommonContext;
  model: string;
  ollama: ModelProvider;
  registry: ToolRegistry;
  toolCtx: ToolContext;
  toolFilter?: (name: string) => boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  numCtx?: number;
}

export interface ExecutorOutput {
  tool: string;
  args: Record<string, unknown>;
  result: ToolResult;
  retryUsed: boolean;
  rawText: string;
  promptEvalCount?: number;
  evalCount?: number;
}

export async function runExecutor(input: ExecutorInput): Promise<ExecutorOutput> {
  const tools: ToolDef[] = input.registry.toolDefs(input.toolFilter);
  const primary = buildExecutorMessages(input.ctx);
  // Gate teeth: never dispatch a tool the filter excludes, even if the model emits
  // it from memory (it isn't in `tools`). Unknown tools still pass through to the
  // unknownTool path for the breaker.
  const allowed = (name: string) =>
    !input.toolFilter || input.toolFilter(name) || !input.registry.has(name);

  const firstCall = await input.ollama.chatOnce({
    model: input.model,
    messages: primary,
    tools,
    toolChoice: 'auto',
    thinking: true,
    timeoutMs: input.timeoutMs ?? 300_000,
    signal: input.signal,
    numCtx: input.numCtx ?? NUM_CTX,
  });
  const firstPick = pickToolCall(firstCall.toolCalls, firstCall.rawText, input.registry);
  if (firstPick && allowed(firstPick.name)) {
    const result = await input.registry.dispatch(firstPick.name, firstPick.args, input.toolCtx);
    return {
      tool: firstPick.name,
      args: firstPick.args,
      result,
      retryUsed: false,
      rawText: firstCall.rawText,
      promptEvalCount: firstCall.promptEvalCount,
      evalCount: firstCall.evalCount,
    };
  }

  // Retry with [assistant-failed, user-nudge]
  const retryMsgs = buildExecutorRetryMessages(primary, firstCall.rawText);
  const retry = await input.ollama.chatOnce({
    model: input.model,
    messages: retryMsgs,
    tools,
    toolChoice: 'required',
    thinking: true,
    timeoutMs: input.timeoutMs ?? 300_000,
    signal: input.signal,
    numCtx: input.numCtx ?? NUM_CTX,
  });
  const retryPick = pickToolCall(retry.toolCalls, retry.rawText, input.registry);
  if (retryPick && allowed(retryPick.name)) {
    const result = await input.registry.dispatch(retryPick.name, retryPick.args, input.toolCtx);
    return {
      tool: retryPick.name,
      args: retryPick.args,
      result,
      retryUsed: true,
      rawText: retry.rawText,
      promptEvalCount: retry.promptEvalCount,
      evalCount: retry.evalCount,
    };
  }

  // No tool call after the nudge. Small models (e4b) often WRITE the answer as
  // prose instead of calling finish. If the model produced a substantial text
  // answer, treat it as the step result and advance — let the Evaluator judge it,
  // rather than counting it as a bogus tool call that trips the circuit breaker.
  const prose = (retry.rawText ?? '').trim();
  if (prose.length >= 80) {
    return {
      tool: 'answer',
      args: {},
      result: { ok: true, content: prose, advanceStep: true },
      retryUsed: true,
      rawText: retry.rawText,
    };
  }

  // Truly empty / non-answer output — surface as unknown so the breaker can react.
  return {
    tool: '(none)',
    args: {},
    result: { ok: false, content: 'Executor produced no tool call after retry.', unknownTool: true },
    retryUsed: true,
    rawText: retry.rawText,
  };
}

interface Picked {
  name: string;
  args: Record<string, unknown>;
}

function pickToolCall(
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>,
  rawText: string,
  registry: ToolRegistry,
): Picked | null {
  for (const tc of toolCalls) {
    if (registry.has(tc.name)) return { name: tc.name, args: tc.args };
  }
  if (toolCalls.length > 0) {
    return { name: toolCalls[0].name, args: toolCalls[0].args };
  }
  const parsed = parseJSONPermissive<{ tool?: string; name?: string; args?: Record<string, unknown>; arguments?: Record<string, unknown> }>(
    rawText,
  );
  if (parsed) {
    const name = parsed.tool ?? parsed.name;
    const args = parsed.args ?? parsed.arguments ?? {};
    if (typeof name === 'string' && name) return { name, args: args as Record<string, unknown> };
  }
  return null;
}

export { pickToolCall as _pickToolCall };
