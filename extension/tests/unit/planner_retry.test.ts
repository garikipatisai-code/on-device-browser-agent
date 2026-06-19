import { describe, expect, it } from 'vitest';
import { runPlanner } from '@/agent/roles/planner';
import { makeFakeOllama, rawResponse } from '../helpers';
import type { CommonContext } from '@/agent/prompts';

const ctx: CommonContext = {
  goal: 'find a wireless mouse',
  toolCatalog: '(tools)',
  plan: null,
  currentStepId: null,
  ownedTabs: [],
};

describe('runPlanner — retry on an unusable plan (do not abort the task on a transient slip)', () => {
  it('retries once and succeeds when the first response has no usable steps', async () => {
    const ollama = makeFakeOllama({
      planner: [
        rawResponse({ content: JSON.stringify({ plan: ['wrong shape'] }) }), // no "steps" key → 0 usable
        rawResponse({ content: JSON.stringify({ steps: [{ description: 'search for it', successCriteria: 'results shown' }] }) }),
      ],
    });
    const out = await runPlanner({ ctx, model: 'm', ollama });
    expect(out.plan.steps).toHaveLength(1);
    expect(out.plan.steps[0].description).toBe('search for it');
  });

  it('throws only after the retry also yields no usable steps', async () => {
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: '{"steps":[]}' }), rawResponse({ content: 'not even json' })],
    });
    await expect(runPlanner({ ctx, model: 'm', ollama })).rejects.toThrow(/no usable steps/i);
  });

  it('does not retry when the first plan is already usable (single planner call)', async () => {
    let calls = 0;
    const ollama = makeFakeOllama(
      {
        planner: [
          rawResponse({ content: JSON.stringify({ steps: [{ description: 'do it', successCriteria: 'done' }] }) }),
          rawResponse({ content: JSON.stringify({ steps: [{ description: 'SHOULD NOT BE USED', successCriteria: 'x' }] }) }),
        ],
      },
      { onChat: (_m, role) => { if (role === 'planner') calls++; } },
    );
    const out = await runPlanner({ ctx, model: 'm', ollama });
    expect(calls).toBe(1);
    expect(out.plan.steps[0].description).toBe('do it');
  });
});
