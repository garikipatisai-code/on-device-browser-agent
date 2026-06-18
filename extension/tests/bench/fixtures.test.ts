import { describe, it, expect } from 'vitest';
import { BENCH_TASKS } from './fixtures';

describe('bench fixtures are well-formed', () => {
  it('has at least the 5 seed tasks with unique ids', () => {
    expect(BENCH_TASKS.length).toBeGreaterThanOrEqual(5);
    const ids = BENCH_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every task: non-empty goal, a start page that exists, and valid transitions', () => {
    for (const t of BENCH_TASKS) {
      expect(t.goal.trim().length).toBeGreaterThan(0);
      // A task either navigates real pages (has a start page) or is search-only.
      if (Object.keys(t.pages).length > 0) {
        expect(t.pages[t.start], `${t.id}: start page "${t.start}" missing`).toBeTruthy();
      }
      for (const tr of t.transitions) {
        expect(t.pages[tr.from], `${t.id}: transition.from "${tr.from}" missing`).toBeTruthy();
        expect(t.pages[tr.to], `${t.id}: transition.to "${tr.to}" missing`).toBeTruthy();
      }
      expect(t.expect.verdict.length).toBeGreaterThan(0);
    }
  });
});
