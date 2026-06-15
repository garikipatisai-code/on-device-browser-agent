// Evaluator role.
import type { OllamaClient } from '@/background/ollama';
import { parseJSONPermissive } from '../util';
import type { Step } from '@/shared/messages';
import { buildEvaluatorMessages, type CommonContext } from '../prompts';
import { NUM_CTX } from '../budget';

export interface EvaluatorInput {
  ctx: CommonContext;
  model: string;
  ollama: OllamaClient;
  lastExecutorResult: string;
  step: Step;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface Verdict {
  verdict: 'PASS' | 'FAIL';
  reason: string;
  shouldReplan: boolean;
  finishVerdict: 'success' | 'partial' | 'blocked' | 'failed' | null;
  finishSummary: string | null;
  raw: string;
}

export async function runEvaluator(input: EvaluatorInput): Promise<Verdict> {
  const messages = buildEvaluatorMessages(input.ctx, input.lastExecutorResult, input.step);
  const resp = await input.ollama.chatOnce({
    model: input.model,
    messages,
    format: 'json',
    thinking: true,
    timeoutMs: input.timeoutMs ?? 120_000,
    signal: input.signal,
    numCtx: NUM_CTX,
  });
  const raw = resp.message.content ?? '';
  const parsed = parseJSONPermissive<Partial<Verdict>>(raw);
  const verdict: 'PASS' | 'FAIL' =
    parsed?.verdict === 'PASS' || parsed?.verdict === 'FAIL' ? parsed.verdict : 'FAIL';
  return {
    verdict,
    reason: typeof parsed?.reason === 'string' ? parsed.reason : 'No evaluator reason provided.',
    shouldReplan: !!parsed?.shouldReplan,
    // 'partial' is intentionally NOT terminal: the evaluator must not end the
    // task mid-goal. Only success/blocked/failed finish it.
    finishVerdict:
      parsed?.finishVerdict === 'success' ||
      parsed?.finishVerdict === 'blocked' ||
      parsed?.finishVerdict === 'failed'
        ? parsed.finishVerdict
        : null,
    finishSummary: typeof parsed?.finishSummary === 'string' ? parsed.finishSummary : null,
    raw,
  };
}
