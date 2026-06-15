// Plan walking: pure, immutable.
import type { Plan, Step } from '@/shared/messages';
import { ulid } from './util';

export function newStep(input: Omit<Step, 'id' | 'status'> & Partial<Pick<Step, 'id' | 'status'>>): Step {
  return {
    id: input.id ?? ulid(),
    description: input.description,
    successCriteria: input.successCriteria,
    toolHint: input.toolHint,
    status: input.status ?? 'pending',
  };
}

export function newPlan(steps: Array<Omit<Step, 'id' | 'status'>>): Plan {
  const built = steps.map((s, i) => newStep({ ...s, status: i === 0 ? 'active' : 'pending' }));
  return { steps: built, created: Date.now() };
}

export function currentStep(plan: Plan | null): Step | null {
  if (!plan) return null;
  return plan.steps.find((s) => s.status === 'active') ?? null;
}

export interface WalkResult {
  plan: Plan;
  terminal: boolean;
  advanced: boolean;
  nextStep: Step | null;
}

export function walkPlan(plan: Plan, stepId: string, outcome: 'done' | 'fail'): WalkResult {
  const idx = plan.steps.findIndex((s) => s.id === stepId);
  if (idx < 0) return { plan, terminal: false, advanced: false, nextStep: currentStep(plan) };
  const next = plan.steps.map((s, i) => {
    if (i === idx) return { ...s, status: outcome === 'done' ? ('completed' as const) : ('failed' as const) };
    return { ...s };
  });
  const nextIdx = next.findIndex((s, i) => i > idx && (s.status === 'pending' || s.status === 'active'));
  let terminal = nextIdx < 0;
  let nextStep: Step | null = null;
  let advanced = false;
  if (!terminal) {
    next[nextIdx] = { ...next[nextIdx], status: 'active' };
    nextStep = next[nextIdx];
    advanced = true;
  }
  return { plan: { ...plan, steps: next }, terminal, advanced, nextStep };
}

export function progressFraction(plan: Plan | null): number {
  if (!plan || plan.steps.length === 0) return 0;
  const done = plan.steps.filter((s) => s.status === 'completed').length;
  return done / plan.steps.length;
}
