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

  it('reports retryFired=true when the parity retry actually fires', async () => {
    const ollama = makeFakeOllama({ planner: [rawResponse({ content: onePlan }), rawResponse({ content: richPlan })] });
    const out = await runPlanner({ ctx, model: 'm', ollama, workflowRecipe: '1\n2\n3', recipeStepCount: 3 });
    expect(out.retryFired).toBe(true);
  });

  it('reports retryFired=false (or undefined) when the plan already met recipe parity (no retry needed)', async () => {
    const ollama = makeFakeOllama({ planner: [rawResponse({ content: richPlan })] });
    const out = await runPlanner({ ctx, model: 'm', ollama, workflowRecipe: '1\n2\n3', recipeStepCount: 3 });
    expect(out.retryFired).toBeFalsy();
  });
});

describe('runPlanner — recipe-parity retry is bounded to once per task (cross-call gating via recipeRetryUsed)', () => {
  // The bug this guards against: the planner's internal recipe-parity retry and the orchestrator's
  // outer replan() loop both key off matchedWorkflow with no shared memory. In the worst case, EVERY
  // outer replan call could ALSO trigger this inner retry (up to 6 planner calls total before giving
  // up). The fix: a `recipeRetryUsed` flag, threaded in via PlannerInput, that once true suppresses
  // the inner retry — regardless of how many times runPlanner itself gets called across the task.
  const onePlan = JSON.stringify({ steps: [{ description: 'search for everything at once', successCriteria: 'gathered' }] });
  const richPlan = JSON.stringify({
    steps: [
      { description: 'open the official source', successCriteria: 'on the official page' },
      { description: 'read the requested fields', successCriteria: 'fields found on the page' },
      { description: 'report only what is shown', successCriteria: 'answer reported' },
    ],
  });

  it('retries on the FIRST call (recipeRetryUsed not yet set) but does NOT retry again on a SECOND call once the flag is true', async () => {
    let calls = 0;
    // Every response under-plans relative to the 3-step recipe, so the retry condition
    // (collapsed plan) is true on BOTH the first and second call to runPlanner — the only thing
    // that may stop the second call's retry is the recipeRetryUsed gate.
    const ollama = makeFakeOllama(
      {
        planner: [
          rawResponse({ content: onePlan }), // call 1, attempt 1 (collapsed → retry fires)
          rawResponse({ content: richPlan }), // call 1, attempt 2 (the retry itself)
          rawResponse({ content: onePlan }), // call 2, attempt 1 (collapsed again, but gated off)
        ],
      },
      { onChat: (_m, role) => { if (role === 'planner') calls++; } },
    );

    // Call 1: simulates the very first planning call for a task. recipeRetryUsed starts unset.
    const out1 = await runPlanner({ ctx, model: 'm', ollama, workflowRecipe: '1\n2\n3', recipeStepCount: 3 });
    expect(calls).toBe(2); // the inner retry DID fire (1 initial + 1 retry)
    expect(out1.retryFired).toBe(true);

    // The orchestrator persists out1.retryFired onto the shared hot state as recipeRetryUsed=true,
    // then calls runPlanner AGAIN from one of the outer replan() calls — same task, same flag.
    const out2 = await runPlanner({
      ctx,
      model: 'm',
      ollama,
      workflowRecipe: '1\n2\n3',
      recipeStepCount: 3,
      recipeRetryUsed: true, // set from call 1's outcome
    });
    // Only ONE more model call happened (the second call's single attempt) — the retry did not
    // fire again, so total calls across BOTH runPlanner invocations is 3, not 4.
    expect(calls).toBe(3);
    expect(out2.plan.steps.length).toBe(1); // the collapsed plan stands — no retry to enrich it
    expect(out2.retryFired).toBeFalsy(); // this call did not itself fire a (new) retry
  });
});
