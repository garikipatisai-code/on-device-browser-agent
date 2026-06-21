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

describe('wikipedia-compare fixture (consistent city-proper basis → Austin, no metro mixing)', () => {
  // Locks in the live failure mode this hardening pass fixed: the agent used to compare one
  // city's CITY-PROPER figure against another's METRO-area figure and wrongly crown Seattle.
  // The honest, like-for-like answer compares each city's city-proper number → Austin (961,855).
  const task = () => BENCH_TASKS.find((t) => t.id === 'wikipedia-compare');
  // observed = the list page, which carries BOTH city and metro figures, so every number in any
  // answer is "grounded" — only mustContain/mustNotContain can enforce the basis (grounding can't).
  const observedText = () => task()?.pages.list.aria ?? '';
  const score = (summary: string) =>
    scoreRun(task()!.expect, { phase: 'DONE', verdict: 'success', turns: 6, replans: 0, summary, observedText: observedText() });

  it('is registered', () => {
    expect(task()).toBeTruthy();
  });

  it('accepts the city-proper comparison that names Austin largest (the live good answer)', () => {
    expect(
      score(
        'Based on Wikipedia data:\n*   **Austin:** 961,855 (at the 2020 census)\n' +
          '*   **Seattle:** 784,777 (in 2025)\n*   **Denver:** 715,522 (at the 2020 census)\n\n' +
          'Austin is the largest city among the three.',
      ),
    ).toMatchObject({ correct: true, grounded: true });
  });

  it('rejects the metro-mixing answer that crowns Seattle (the historic failure)', () => {
    const wrong = score(
      'Seattle has the largest population — its metropolitan area is over 4.15 million, vs Austin metro 2.55 million.',
    );
    expect(wrong.correct).toBe(false); // missing the city-proper figures + never names Austin largest
    expect(wrong.grounded).toBe(false); // metro figures + "Seattle largest" are on-page but the wrong basis
  });

  it('rejects the right-numbers/wrong-verdict answer (Seattle crowned despite city figures)', () => {
    // All three city numbers present and grounded, but the conclusion is arithmetically wrong.
    const wrong = score('Austin 961,855, Seattle 784,777, Denver 715,522 — Seattle is the largest.');
    expect(wrong.correct).toBe(false); // "Austin … largest" not asserted
    expect(wrong.grounded).toBe(false); // "Seattle … largest" trips mustNotContain
  });
});
