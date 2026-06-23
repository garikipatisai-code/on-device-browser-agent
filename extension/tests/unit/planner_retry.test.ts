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

describe('runPlanner — recipe-parity retry (a recipe task must not collapse below the recipe’s step count)', () => {
  // Live failure: a "find facilities on the British Museum site" goal matched seed-contact (3 steps)
  // but the planner emitted ONE mis-scoped step. The retry now KEEPS the recipe and nudges for one
  // plan step per recipe step (expanding any "for each item" step per named item).
  const onePlan = JSON.stringify({ steps: [{ description: 'search for everything at once', successCriteria: 'gathered' }] });
  const twoPlan = JSON.stringify({
    steps: [
      { description: 'search', successCriteria: 'a' },
      { description: 'report', successCriteria: 'b' },
    ],
  });
  const richPlan = JSON.stringify({
    steps: [
      { description: 'open the official source', successCriteria: 'on the official page' },
      { description: 'read the requested fields', successCriteria: 'fields found on the page' },
      { description: 'report only what is shown', successCriteria: 'answer reported' },
    ],
  });

  it('retries KEEPING the recipe on a collapsed plan, adopting the richer decomposition', async () => {
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
    const out = await runPlanner({ ctx, model: 'm', ollama, workflowRecipe: '1. Open\n2. Read\n3. Report', recipeStepCount: 3 });
    expect(out.plan.steps.length).toBeGreaterThanOrEqual(3);
    expect(calls).toBe(2);
    expect(recipeSeen[0]).toBe(true); // first attempt carried the recipe
    expect(recipeSeen[1]).toBe(true); // retry KEEPS the recipe now (it used to drop it)
  });

  it('fires when the plan is thinner than the recipe even if it is not a lone step (2 < 3)', async () => {
    let calls = 0;
    const ollama = makeFakeOllama(
      { planner: [rawResponse({ content: twoPlan }), rawResponse({ content: richPlan })] },
      { onChat: (_m, role) => { if (role === 'planner') calls++; } },
    );
    const out = await runPlanner({ ctx, model: 'm', ollama, workflowRecipe: '1\n2\n3', recipeStepCount: 3 });
    expect(calls).toBe(2);
    expect(out.plan.steps.length).toBe(3);
  });

  it('keeps the original plan if the retry is no richer (never makes it worse)', async () => {
    const ollama = makeFakeOllama({ planner: [rawResponse({ content: onePlan }), rawResponse({ content: onePlan })] });
    const out = await runPlanner({ ctx, model: 'm', ollama, workflowRecipe: '1\n2\n3', recipeStepCount: 3 });
    expect(out.plan.steps.length).toBe(1);
  });

  it('does NOT retry when the plan already meets the recipe step count (single planner call)', async () => {
    let calls = 0;
    const ollama = makeFakeOllama(
      { planner: [rawResponse({ content: richPlan })] },
      { onChat: (_m, role) => { if (role === 'planner') calls++; } },
    );
    const out = await runPlanner({ ctx, model: 'm', ollama, workflowRecipe: '1\n2\n3', recipeStepCount: 3 });
    expect(calls).toBe(1);
    expect(out.plan.steps.length).toBe(3);
  });

  it('does NOT do the parity retry when no recipe was used (a lone-step plan stands)', async () => {
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
