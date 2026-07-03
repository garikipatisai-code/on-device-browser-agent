// The sous chef seat: checks the work. Wraps roles/evaluator.ts unchanged,
// and owns grounding verification (moved here from orchestrator.ts — "does
// this actually hold up before it goes out" is exactly the sous chef's job).
import { runEvaluator, type EvaluatorInput, type Verdict } from '../roles/evaluator';
import type { ModelProvider } from './provider';
import { ungroundedNumbers } from '../verify/grounding';
import { groundingCorpus, type Fact } from '../facts';

export async function runSousChef(
  provider: ModelProvider,
  input: Omit<EvaluatorInput, 'ollama'>,
): Promise<Verdict> {
  return runEvaluator({ ...input, ollama: provider });
}

/** Verify a success answer is grounded in what was actually read.
 *  Deterministic number check only: an e4b LLM verify was tried but false-rejected
 *  correct/honest answers in the benchmark (correct 80%→67%), so it was dropped —
 *  see docs/superpowers/specs/2026-06-18-theme-a-page-grounded-verification-design.md. */
export function verifyFinish(
  summary: string,
  observedText: string,
  facts: Fact[],
): { ok: boolean; reason: string } {
  if (!summary || !summary.trim()) {
    return { ok: false, reason: 'no answer text provided' };
  }
  const ungrounded = ungroundedNumbers(summary, groundingCorpus(observedText, facts));
  if (ungrounded.length) {
    return { ok: false, reason: `value(s) not found on any page read: ${ungrounded.join(', ')}` };
  }
  return { ok: true, reason: '' };
}

/** Gate any data-bearing finish (executor OR evaluator) through the deterministic grounding
 *  check. Both roles are the same small-model class and can assert a number that's on no page
 *  read. A 'success' carrying an ungrounded (or empty) answer is downgraded to 'partial'; a
 *  'partial' keeps its verdict but gets the unverified note appended (it's already a concession).
 *  'blocked'/'failed' are honest non-answers with no fabrication risk and pass through unchanged. */
export function gateFinishSummary(
  verdict: string,
  summary: string,
  observedText: string,
  facts: Fact[],
): { verdict: string; summary: string } {
  if (verdict !== 'success' && verdict !== 'partial') return { verdict, summary };
  const v = verifyFinish(summary, observedText, facts);
  if (v.ok) return { verdict, summary };
  return { verdict: 'partial', summary: `${summary}\n\n[unverified against page: ${v.reason}]` };
}
