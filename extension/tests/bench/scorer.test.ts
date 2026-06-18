import { describe, it, expect } from 'vitest';
import { dataNumbers, ungroundedNumbers, scoreRun, type BenchRun } from './scorer';

const PAGES = 'Logitech M185 Wireless Mouse Price: $13.42 Rating: 4.6 out of 5 stars';

function run(over: Partial<BenchRun>): BenchRun {
  return {
    phase: 'DONE', verdict: 'success',
    summary: '', observedText: PAGES, turns: 3, replans: 0,
    ...over,
  };
}

describe('dataNumbers', () => {
  it('extracts prices, decimals and multi-digit ints; ignores single-digit list markers', () => {
    expect(dataNumbers('1. M185 $13.42 rated 4.6')).toEqual(['13.42', '4.6']);
    expect(dataNumbers('top 3 results')).toEqual([]); // "3" is a single digit → ignored
    expect(dataNumbers('year 2025')).toEqual(['2025']);
  });
});

describe('ungroundedNumbers', () => {
  it('flags a number absent from observed text (hallucination), passes a present one', () => {
    expect(ungroundedNumbers('It costs $13.42', PAGES)).toEqual([]);
    expect(ungroundedNumbers('It costs $99.99', PAGES)).toEqual(['99.99']);
  });
});

describe('scoreRun', () => {
  it('all green when verdict + facts match and numbers are grounded', () => {
    const s = scoreRun(
      { verdict: ['success'], mustContain: ['Logitech M185', /\$13\.42/, /4\.6/] },
      run({ summary: 'Logitech M185 Wireless Mouse — $13.42, rated 4.6' }),
    );
    expect(s).toMatchObject({ completed: true, correct: true, grounded: true });
  });

  it('grounded=false when the answer invents a price', () => {
    const s = scoreRun(
      { verdict: ['success'], mustContain: ['Logitech M185'] },
      run({ summary: 'Logitech M185 Wireless Mouse — $99.99' }),
    );
    expect(s.correct).toBe(true);     // the required string is present
    expect(s.grounded).toBe(false);   // but $99.99 is not on any page → hallucination
    expect(s.reasons.join(' ')).toContain('99.99');
  });

  it('grounded=false when the answer asserts a field that never appeared on the page (fabrication)', () => {
    const exp = { verdict: ['success'], mustContain: [/\$13\.42/], mustNotContain: [/\b\d\s*stars?\b/i] };
    const s = scoreRun(
      exp,
      run({ summary: 'Logitech M185 — $13.42, rated 5 stars', observedText: 'Logitech M185 Price: $13.42' }),
    );
    expect(s.correct).toBe(true);    // the price is present and grounded
    expect(s.grounded).toBe(false);  // "5 stars" was never on the page → fabricated, not a real read
    expect(s.reasons.join(' ')).toMatch(/fabricat|not on (the )?page|forbidden/i);
  });

  it('grounded=true when the absent field is honestly declined instead of fabricated', () => {
    const exp = { verdict: ['success'], mustContain: [/\$13\.42/], mustNotContain: [/\b\d\s*stars?\b/i] };
    const s = scoreRun(
      exp,
      run({ summary: 'Logitech M185 — $13.42. Star rating: not shown on the page.', observedText: 'Logitech M185 Price: $13.42' }),
    );
    expect(s).toMatchObject({ correct: true, grounded: true });
  });

  it('correct=false when a required fact is missing', () => {
    const s = scoreRun(
      { verdict: ['success'], mustContain: ['Logitech M185', /4\.6/] },
      run({ summary: 'Some mouse, no rating given' }),
    );
    expect(s.correct).toBe(false);
  });

  it('correct=false when verdict is not in the accepted set', () => {
    const s = scoreRun({ verdict: ['blocked', 'failed'] }, run({ verdict: 'success', summary: 'here it is' }));
    expect(s.correct).toBe(false);
  });

  it('completed=false when the run aborted (loop / max-turns)', () => {
    const s = scoreRun({ verdict: ['success'] }, run({ phase: 'ABORTED', verdict: 'aborted' }));
    expect(s.completed).toBe(false);
  });

  it('orderedList must appear in order', () => {
    const exp = { verdict: ['success'], orderedList: ['$4.99', '$7.99', '$9.99'] };
    const obs = 'Cable C $4.99 Cable A $7.99 Cable D $9.99';
    expect(scoreRun(exp, run({ summary: '1. $4.99 2. $7.99 3. $9.99', observedText: obs })).correct).toBe(true);
    expect(scoreRun(exp, run({ summary: '1. $7.99 2. $4.99 3. $9.99', observedText: obs })).correct).toBe(false);
  });

  it('empty-honesty: an honest "no results" answer is correct AND grounded', () => {
    const s = scoreRun(
      { verdict: ['blocked', 'failed'], mustContain: [/no results|not found/i] },
      run({ phase: 'DONE', verdict: 'blocked', summary: 'No results found for that product.', observedText: 'No results' }),
    );
    expect(s).toMatchObject({ completed: true, correct: true, grounded: true });
  });
});
