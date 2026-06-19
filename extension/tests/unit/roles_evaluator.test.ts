import { describe, expect, it } from 'vitest';
import { runEvaluator } from '@/agent/roles/evaluator';
import type { OllamaClient } from '@/background/ollama';
import type { CommonContext } from '@/agent/prompts';
import type { Step } from '@/shared/messages';

const fakeOllama = (content: string) =>
  ({ chatOnce: async () => ({ message: { content } }) }) as unknown as OllamaClient;

const ctx = { goal: 'g', toolCatalog: '', plan: null, currentStepId: null, ownedTabs: [] } as CommonContext;
const step = { id: 's', description: 'd', successCriteria: 'c', status: 'active' } as Step;

describe('runEvaluator — verdict normalization (small models emit odd casing)', () => {
  it('normalizes a lowercase/whitespace verdict to PASS instead of defaulting to FAIL', async () => {
    const ev = await runEvaluator({
      ctx,
      model: 'm',
      ollama: fakeOllama('{"verdict":"pass","reason":"ok"}'),
      lastExecutorResult: 'r',
      step,
    });
    expect(ev.verdict).toBe('PASS');
  });

  it('normalizes finishVerdict casing', async () => {
    const ev = await runEvaluator({
      ctx,
      model: 'm',
      ollama: fakeOllama('{"verdict":"PASS","finishVerdict":"Success","finishSummary":"done"}'),
      lastExecutorResult: 'r',
      step,
    });
    expect(ev.finishVerdict).toBe('success');
  });
});
