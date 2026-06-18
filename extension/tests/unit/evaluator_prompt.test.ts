import { describe, it, expect } from 'vitest';
import { buildEvaluatorMessages, type CommonContext } from '@/agent/prompts';
import type { Step } from '@/shared/messages';

const step: Step = { id: 's1', description: 'read product', successCriteria: 'price found', status: 'active' };
const baseCtx: CommonContext = {
  goal: 'find the price',
  toolCatalog: '',
  plan: null,
  currentStepId: 's1',
  ownedTabs: [],
};

describe('buildEvaluatorMessages — page-aware', () => {
  it('includes CURRENT PAGE CONTENT when pageContentBlock is set', () => {
    const msgs = buildEvaluatorMessages(
      { ...baseCtx, pageContentBlock: 'PAGE: price £10.00' },
      'I found £10.00',
      step,
    );
    const user = msgs.find((m) => m.role === 'user')!.content;
    expect(user).toContain('CURRENT PAGE CONTENT');
    expect(user).toContain('price £10.00');
  });

  it('instructs the evaluator to verify claims against the page', () => {
    const msgs = buildEvaluatorMessages({ ...baseCtx, pageContentBlock: 'x' }, 'r', step);
    const sys = msgs.find((m) => m.role === 'system')!.content;
    expect(sys).toMatch(/not present in the page|unsupported claim|verify .*against the page/i);
  });
});
