// Evaluator role.
import type { ModelProvider } from '../framework/provider';
import { parseJSONPermissive } from '../util';
import type { Step } from '@/shared/messages';
import { buildEvaluatorMessages, type CommonContext } from '../prompts';
import { NUM_CTX } from '../budget';

export interface EvaluatorInput {
  ctx: CommonContext;
  model: string;
  ollama: ModelProvider;
  lastExecutorResult: string;
  step: Step;
  signal?: AbortSignal;
  timeoutMs?: number;
  numCtx?: number;
}

export interface Verdict {
  verdict: 'PASS' | 'FAIL';
  reason: string;
  shouldReplan: boolean;
  finishVerdict: 'success' | 'partial' | 'blocked' | 'failed' | null;
  finishSummary: string | null;
  /** One short grounded datum this step established (copied from the page), or null. */
  fact: string | null;
  raw: string;
}

export function parseVerdict(raw: string): Verdict {
  const parsed = parseJSONPermissive<Partial<Verdict>>(raw);
  // Small models emit odd casing/whitespace even under format:json — normalize so a
  // clearly-passing verdict isn't silently defaulted to FAIL.
  let v = String(parsed?.verdict ?? '').trim().toUpperCase();
  if (v !== 'PASS' && v !== 'FAIL') {
    // Structured parse failed (response cut off mid-JSON). Salvage just the PASS/FAIL token.
    // We do NOT salvage finishVerdict or fact — those on a truncated body would be unsafe.
    const m = raw.match(/"?verdict"?\s*[:=]\s*"?\s*(PASS|FAIL)/i);
    if (m) v = m[1].toUpperCase();
  }
  const verdict: 'PASS' | 'FAIL' = v === 'PASS' ? 'PASS' : 'FAIL';
  // 'partial' is intentionally NOT terminal: the evaluator must not end the task
  // mid-goal. Only success/blocked/failed finish it.
  const fv = String(parsed?.finishVerdict ?? '').trim().toLowerCase();
  const fact = typeof parsed?.fact === 'string' && parsed.fact.trim() ? parsed.fact.trim() : null;
  return {
    verdict,
    reason: typeof parsed?.reason === 'string' ? parsed.reason : 'No evaluator reason provided.',
    shouldReplan: !!parsed?.shouldReplan,
    finishVerdict: fv === 'success' ? 'success' : fv === 'blocked' ? 'blocked' : fv === 'failed' ? 'failed' : null,
    finishSummary: typeof parsed?.finishSummary === 'string' ? parsed.finishSummary : null,
    fact,
    raw,
  };
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
    numCtx: input.numCtx ?? NUM_CTX,
  });
  const raw = resp.message.content ?? '';
  return parseVerdict(raw);
}
