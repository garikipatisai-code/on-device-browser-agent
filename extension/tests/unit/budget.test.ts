import { describe, expect, it } from 'vitest';
import { checkBudget, BUDGETS, truncateSection } from '@/agent/budget';
import { TokenRatioEstimator } from '@/agent/util';

describe('checkBudget', () => {
  const est = new TokenRatioEstimator();

  it('under-budget when small', () => {
    const r = checkBudget('executor', 'hello world', est);
    expect(r.overBudget).toBe(false);
    expect(r.tokens).toBeLessThan(10);
  });

  it('marks executor as needing compaction at 80%', () => {
    const big = 'x'.repeat(BUDGETS.executor * 4 * 0.85);
    const r = checkBudget('executor', big, est);
    expect(r.shouldCompact).toBe(true);
  });

  it('does not request compaction for non-executor roles', () => {
    const big = 'x'.repeat(BUDGETS.planner * 4 * 0.85);
    const r = checkBudget('planner', big, est);
    expect(r.shouldCompact).toBe(false);
  });

  it('flags overBudget when exceeding limit', () => {
    const huge = 'y'.repeat(BUDGETS.executor * 4 * 2);
    const r = checkBudget('executor', huge, est);
    expect(r.overBudget).toBe(true);
  });
});

describe('truncateSection', () => {
  it('replaces section content with a marker', () => {
    const input = 'GOAL: x\n\nFINDINGS: big content\nmore\nlines\n\nNEXT: y';
    const out = truncateSection(input, 'FINDINGS', 100);
    expect(out).toContain('FINDINGS: [truncated for budget — 100ch]');
    expect(out).toContain('GOAL: x');
    expect(out).toContain('NEXT: y');
  });
  it('is a no-op when section missing', () => {
    const input = 'GOAL: a\n\nPLAN: b';
    expect(truncateSection(input, 'FINDINGS', 5)).toBe(input);
  });
});
