import { describe, expect, it } from 'vitest';
import { currentStep, newPlan, walkPlan } from '@/agent/plan';

describe('newPlan', () => {
  it('marks first step active, rest pending', () => {
    const p = newPlan([
      { description: 'a', successCriteria: 'a-ok' },
      { description: 'b', successCriteria: 'b-ok' },
      { description: 'c', successCriteria: 'c-ok' },
    ]);
    expect(p.steps[0].status).toBe('active');
    expect(p.steps[1].status).toBe('pending');
    expect(p.steps[2].status).toBe('pending');
  });
});

describe('walkPlan', () => {
  const base = newPlan([
    { description: 'a', successCriteria: 'a' },
    { description: 'b', successCriteria: 'b' },
    { description: 'c', successCriteria: 'c' },
  ]);

  it('advances on done', () => {
    const r = walkPlan(base, base.steps[0].id, 'done');
    expect(r.terminal).toBe(false);
    expect(r.plan.steps[0].status).toBe('completed');
    expect(r.plan.steps[1].status).toBe('active');
    expect(r.advanced).toBe(true);
  });

  it('marks failed but still advances', () => {
    const r = walkPlan(base, base.steps[0].id, 'fail');
    expect(r.plan.steps[0].status).toBe('failed');
    expect(r.plan.steps[1].status).toBe('active');
  });

  it('terminates after last step', () => {
    const p1 = walkPlan(base, base.steps[0].id, 'done').plan;
    const p2 = walkPlan(p1, p1.steps[1].id, 'done').plan;
    const p3 = walkPlan(p2, p2.steps[2].id, 'done');
    expect(p3.terminal).toBe(true);
    expect(p3.nextStep).toBeNull();
  });

  it('is pure (does not mutate input)', () => {
    const before = JSON.parse(JSON.stringify(base));
    walkPlan(base, base.steps[0].id, 'done');
    expect(base).toEqual(before);
  });

  it('returns same plan if step id unknown', () => {
    const r = walkPlan(base, 'no-such-id', 'done');
    expect(r.plan).toBe(base);
    expect(r.advanced).toBe(false);
  });
});

describe('currentStep', () => {
  it('returns active step', () => {
    const p = newPlan([{ description: 'a', successCriteria: 'a' }, { description: 'b', successCriteria: 'b' }]);
    expect(currentStep(p)?.description).toBe('a');
  });
  it('returns null for empty plan', () => {
    expect(currentStep(null)).toBeNull();
  });
});
