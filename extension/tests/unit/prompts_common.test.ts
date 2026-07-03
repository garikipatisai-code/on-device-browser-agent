import { describe, it, expect } from 'vitest';
import { buildPlannerMessages, buildEvaluatorMessages, type CommonContext } from '@/agent/prompts';

const baseCtx: CommonContext = {
  goal: 'test goal',
  toolCatalog: 'tool: echo',
  plan: null,
  currentStepId: null,
  ownedTabs: [],
};

describe('priorSummary in prompts', () => {
  it('buildPlannerMessages omits the prior-turn block when priorSummary is absent', () => {
    const msgs = buildPlannerMessages(baseCtx);
    const user = msgs.find((m) => m.role === 'user')!.content;
    expect(user).not.toContain('PRIOR TURN IN THIS SESSION');
  });

  it('buildPlannerMessages includes the prior-turn block when priorSummary is set', () => {
    const msgs = buildPlannerMessages({ ...baseCtx, priorSummary: 'success: Austin has 961,855 residents' });
    const user = msgs.find((m) => m.role === 'user')!.content;
    expect(user).toContain('PRIOR TURN IN THIS SESSION');
    expect(user).toContain('Austin has 961,855 residents');
  });

  it('buildEvaluatorMessages includes the prior-turn block when priorSummary is set', () => {
    const step = { id: 's1', description: 'd', successCriteria: 'c', status: 'active' as const };
    const msgs = buildEvaluatorMessages(
      { ...baseCtx, priorSummary: 'success: Austin has 961,855 residents' },
      'executor result',
      step,
    );
    const user = msgs.find((m) => m.role === 'user')!.content;
    expect(user).toContain('PRIOR TURN IN THIS SESSION');
  });
});
