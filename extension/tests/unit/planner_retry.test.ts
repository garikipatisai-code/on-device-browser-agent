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

describe('runPlanner — a recipe must not collapse a multi-part goal into a single step', () => {
  // Live failure: a matched recipe seeded a 1-step plan ("search for all three in sequence") for a
  // 3-city comparison → one combined search → a giant list page → wrong answer. When a recipe is
  // injected but the plan comes back as a lone step, retry once WITHOUT the recipe so the planner
  // decomposes the goal freely.
  const onePlan = JSON.stringify({ steps: [{ description: 'search for all three in sequence', successCriteria: 'gathered' }] });
  const richPlan = JSON.stringify({
    steps: [
      { description: 'find Austin population', successCriteria: 'a' },
      { description: 'find Seattle population', successCriteria: 'b' },
      { description: 'find Denver population', successCriteria: 'c' },
      { description: 'compare and report', successCriteria: 'd' },
    ],
  });

  it('retries WITHOUT the recipe on a lone-step recipe plan, adopting the richer decomposition', async () => {
    const recipeSeen: boolean[] = [];
    let calls = 0;
    const ollama = makeFakeOllama(
      { planner: [rawResponse({ content: onePlan }), rawResponse({ content: richPlan })] },
      {
        onChat: (_m, role, messages) => {
          if (role !== 'planner') return;
          calls++;
          recipeSeen.push(messages.some((m) => /known-good sequence/i.test(m.content)));
        },
      },
    );
    const out = await runPlanner({ ctx, model: 'm', ollama, workflowRecipe: '1. Search\n2. Report' });
    expect(out.plan.steps.length).toBeGreaterThanOrEqual(3);
    expect(calls).toBe(2);
    expect(recipeSeen[0]).toBe(true); // first attempt carried the recipe
    expect(recipeSeen[1]).toBe(false); // retry dropped it
  });

  it('keeps the single step if the recipe-free retry is no richer (never makes the plan worse)', async () => {
    const ollama = makeFakeOllama({ planner: [rawResponse({ content: onePlan }), rawResponse({ content: onePlan })] });
    const out = await runPlanner({ ctx, model: 'm', ollama, workflowRecipe: '1. Search' });
    expect(out.plan.steps.length).toBe(1);
  });

  it('does NOT do the recipe-free retry when no recipe was used (a lone-step plan stands)', async () => {
    let calls = 0;
    const ollama = makeFakeOllama(
      { planner: [rawResponse({ content: onePlan })] },
      { onChat: (_m, role) => { if (role === 'planner') calls++; } },
    );
    const out = await runPlanner({ ctx, model: 'm', ollama });
    expect(out.plan.steps.length).toBe(1);
    expect(calls).toBe(1);
  });
});
