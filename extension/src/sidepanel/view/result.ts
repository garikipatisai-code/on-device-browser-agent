// Pure view-model derivations from the timeline + plan.
import type { Plan, TimelineEvent } from '@/shared/messages';

export interface FinishView {
  verdict: string;
  summary: string;
}

/** The most recent finish event (the answer to hero), or null if none yet. */
export function latestFinish(events: TimelineEvent[]): FinishView | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === 'finish') return { verdict: e.verdict, summary: e.summary };
  }
  return null;
}

export interface PlanProgress {
  total: number;
  done: number;
  activeIndex: number;
}

/** Step counts + the active step index, for the live checklist + progress meter. */
export function planProgress(plan: Plan | null): PlanProgress {
  if (!plan || plan.steps.length === 0) return { total: 0, done: 0, activeIndex: -1 };
  const done = plan.steps.filter((s) => s.status === 'completed').length;
  const activeIndex = plan.steps.findIndex((s) => s.status === 'active');
  return { total: plan.steps.length, done, activeIndex };
}
