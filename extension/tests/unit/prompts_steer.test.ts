import { describe, it, expect } from 'vitest';
import { buildExecutorMessages, buildPlannerMessages, type CommonContext } from '@/agent/prompts';

const base: CommonContext = {
  goal: 'compare the populations of Austin, Seattle, and Denver',
  toolCatalog: '',
  plan: null,
  currentStepId: null,
  ownedTabs: [],
};

// Mid-task "steer": the user corrects a running task without aborting it; the correction must
// surface as high-priority guidance on the next executor turn (and on any replan).
describe('steer guidance injection', () => {
  it('executor: surfaces a mid-task steer as guidance the model must follow', () => {
    const user = buildExecutorMessages({ ...base, steerNotes: ['search each city separately'] }).find(
      (m) => m.role === 'user',
    )!.content;
    expect(user).toMatch(/guidance|steer/i);
    expect(user).toContain('search each city separately');
  });

  it('executor: no guidance block when there are no steer notes', () => {
    const user = buildExecutorMessages(base).find((m) => m.role === 'user')!.content;
    expect(user).not.toMatch(/USER GUIDANCE/);
  });

  it('planner: also surfaces steer notes so a replan honors the correction', () => {
    const user = buildPlannerMessages({ ...base, steerNotes: ['use each city-proper figure'] }).find(
      (m) => m.role === 'user',
    )!.content;
    expect(user).toContain('use each city-proper figure');
  });
});
