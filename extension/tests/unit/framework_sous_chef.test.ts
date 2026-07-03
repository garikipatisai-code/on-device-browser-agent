import { describe, it, expect } from 'vitest';
import { runSousChef, verifyFinish, gateFinishSummary } from '@/agent/framework/sous_chef';
import { localProvider } from '@/agent/framework/provider';
import { makeFakeOllama, rawResponse } from '../helpers';

describe('runSousChef', () => {
  it('delegates to runEvaluator with the given provider', async () => {
    const fake = makeFakeOllama({
      evaluator: [rawResponse({ content: '{"verdict":"PASS","reason":"ok"}' })],
    });
    const ev = await runSousChef(localProvider(fake), {
      ctx: { goal: 'test', toolCatalog: '' } as never,
      model: 'x',
      lastExecutorResult: 'result',
      step: { id: '1', description: 'd', successCriteria: 's', status: 'active' },
    });
    expect(ev.verdict).toBe('PASS');
  });
});

describe('verifyFinish', () => {
  it('accepts a summary whose numbers were actually observed', () => {
    const v = verifyFinish('The price is $24.99', 'the page shows $24.99 in stock', []);
    expect(v.ok).toBe(true);
  });

  it('rejects a summary asserting a number never observed', () => {
    const v = verifyFinish('The price is $999.99', 'the page shows $24.99 in stock', []);
    expect(v.ok).toBe(false);
  });
});

describe('gateFinishSummary', () => {
  it('downgrades an ungrounded success to partial with an unverified note', () => {
    const g = gateFinishSummary('success', 'The price is $999.99', 'the page shows $24.99', []);
    expect(g.verdict).toBe('partial');
    expect(g.summary).toContain('[unverified against page');
  });

  it('passes through blocked/failed verdicts unchanged', () => {
    const g = gateFinishSummary('blocked', 'could not access the page', '', []);
    expect(g).toEqual({ verdict: 'blocked', summary: 'could not access the page' });
  });
});
