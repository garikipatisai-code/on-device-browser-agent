import { describe, it, expect } from 'vitest';
import { runHeadChef } from '@/agent/framework/head_chef';
import { localProvider } from '@/agent/framework/provider';
import { makeFakeOllama, rawResponse } from '../helpers';

describe('runHeadChef', () => {
  it('delegates to runPlanner with the given provider', async () => {
    const fake = makeFakeOllama({
      planner: [rawResponse({ content: '{"steps":[{"description":"do it","successCriteria":"done"}]}' })],
    });
    const out = await runHeadChef(localProvider(fake), {
      ctx: { goal: 'test', toolCatalog: '', plan: null, currentStepId: null, ownedTabs: [] },
      model: 'x',
    });
    expect(out.plan.steps).toHaveLength(1);
    expect(out.plan.steps[0].description).toBe('do it');
  });
});
