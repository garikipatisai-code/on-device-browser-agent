import { describe, it, expect } from 'vitest';
import { BENCH_TASKS } from './fixtures';
import { scoreRun } from './scorer';

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

describe('field-absent fixture (a11y-invisible field → honest gap, never fabricated)', () => {
  const find = () => BENCH_TASKS.find((t) => t.id === 'field-absent');
  const score = (summary: string) =>
    scoreRun(find()!.expect, {
      phase: 'DONE',
      verdict: 'success',
      turns: 3,
      replans: 0,
      summary,
      observedText: 'Price: £51.77 Availability: In stock (22 available)',
    });

  it('is registered', () => {
    expect(find()).toBeTruthy();
  });

  it('flags a fabricated star rating as not grounded', () => {
    expect(score('Price: £51.77, in stock (22 available). Star rating: 5 stars.').grounded).toBe(false);
  });

  it('accepts an honest "rating not shown" answer as correct and grounded', () => {
    expect(
      score('Price: £51.77, in stock (22 available). Star rating: not shown on the page.'),
    ).toMatchObject({ correct: true, grounded: true });
  });

  it('accepts the real e4b phrasing "not explicitly rated with numbers" as an honest gap', () => {
    // Observed live on books.toscrape: e4b declines the rating like this instead of
    // fabricating "5 stars". "5 empty stars" describes the icon widget (not a value
    // claim), so it must NOT trip mustNotContain.
    expect(
      score(
        'Price: £51.77. In stock (22 available). Star rating: not explicitly rated with numbers (appears as 5 empty stars on the page).',
      ),
    ).toMatchObject({ correct: true, grounded: true });
  });
});

describe('adversarial distractor fixtures (semantic selection, not just grounding)', () => {
  const obs = (id: string) =>
    BENCH_TASKS.find((t) => t.id === id)!.pages.product.aria;
  const score = (id: string, summary: string) =>
    scoreRun(BENCH_TASKS.find((t) => t.id === id)!.expect, {
      phase: 'DONE',
      verdict: 'success',
      turns: 2,
      replans: 0,
      summary,
      observedText: obs(id),
    });

  it('sale-price + spec-pick are registered', () => {
    expect(BENCH_TASKS.find((t) => t.id === 'sale-price')).toBeTruthy();
    expect(BENCH_TASKS.find((t) => t.id === 'spec-pick')).toBeTruthy();
  });

  it('sale-price: the current price passes, the struck-through "was" price alone fails', () => {
    expect(score('sale-price', 'The current price is £59.99.').correct).toBe(true);
    // Reporting only the "was" price is wrong — and £79.99 is on the page so grounding alone misses it.
    const wrong = score('sale-price', 'The price is £79.99.');
    expect(wrong.correct).toBe(false);
    expect(wrong.grounded).toBe(true); // exactly why mustContain (not grounding) is the guard here
  });

  it('spec-pick: the weight passes, a different (grounded) spec fails', () => {
    expect(score('spec-pick', 'It weighs 1100 g.').correct).toBe(true);
    expect(score('spec-pick', 'The capacity is 30 litres.').correct).toBe(false);
  });
});
