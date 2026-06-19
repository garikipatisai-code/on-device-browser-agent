import { describe, expect, it } from 'vitest';
import { runEvaluator } from '@/agent/roles/evaluator';
import { makeFakeOllama, rawResponse } from '../helpers';
import type { CommonContext } from '@/agent/prompts';
import type { Step } from '@/shared/messages';

const ctx: CommonContext = {
  goal: 'report the price',
  toolCatalog: '(tools)',
  plan: null,
  currentStepId: null,
  ownedTabs: [],
};
const step: Step = { id: 's1', description: 'read and report', successCriteria: 'price reported', status: 'active' };

describe('runEvaluator — salvage a verdict from a truncated response', () => {
  it('recovers a PASS that was cut off mid-JSON instead of silently failing the step', async () => {
    // e4b under thinking + a 120s cap can be cut mid-object; format:json then yields invalid JSON.
    const ollama = makeFakeOllama({
      evaluator: [rawResponse({ content: '{"verdict":"PASS","reason":"the page clearly shows the price £10.00 and the' })],
    });
    const v = await runEvaluator({ ctx, model: 'm', ollama, lastExecutorResult: 'I read the page', step });
    expect(v.verdict).toBe('PASS');
  });

  it('still defaults to FAIL when no verdict can be recovered at all', async () => {
    const ollama = makeFakeOllama({ evaluator: [rawResponse({ content: 'totally unparseable output' })] });
    const v = await runEvaluator({ ctx, model: 'm', ollama, lastExecutorResult: 'x', step });
    expect(v.verdict).toBe('FAIL');
  });

  it('does not let a salvaged verdict terminate the task (no finishVerdict from a truncated body)', async () => {
    const ollama = makeFakeOllama({
      evaluator: [rawResponse({ content: '{"verdict":"PASS","reason":"looks good and the finishVerdict should be' })],
    });
    const v = await runEvaluator({ ctx, model: 'm', ollama, lastExecutorResult: 'x', step });
    expect(v.verdict).toBe('PASS');
    expect(v.finishVerdict).toBeNull();
  });
});
