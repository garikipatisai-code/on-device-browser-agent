import { describe, it, expect } from 'vitest';
import { aggregate, formatReport, type TaskResult } from './report';
import type { Score } from './scorer';

const score = (o: Partial<Score>): Score => ({ completed: true, correct: true, grounded: true, reasons: [], ...o });

const results: TaskResult[] = [
  { id: 'a', scores: [score({}), score({ grounded: false })], turns: [3, 4] },
  { id: 'b', scores: [score({ correct: false, grounded: false })], turns: [9] },
];

describe('aggregate', () => {
  it('computes per-dimension rates over all trials', () => {
    const agg = aggregate(results);
    expect(agg.total).toBe(3);               // 2 + 1 trials
    expect(agg.completed).toBe(3);           // all completed
    expect(agg.correct).toBe(2);             // a×2 correct, b×0
    expect(agg.grounded).toBe(1);            // only a-trial-1
  });
});

describe('formatReport', () => {
  it('renders per-task lines and a totals block', () => {
    const out = formatReport(results, { model: 'gemma4:e4b', trials: 2 });
    expect(out).toContain('gemma4:e4b');
    expect(out).toContain('a ');
    expect(out).toContain('grounded');
    expect(out).toMatch(/completed\s+\d+%/);
  });
});
