import { describe, it, expect } from 'vitest';
import { dataNumbers, ungroundedNumbers } from './grounding';

const PAGES = 'Logitech M185 Wireless Mouse Price: $13.42 Rating: 4.6 out of 5 stars';

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

  it('does not count a number that is only a digit-substring of an observed number', () => {
    expect(ungroundedNumbers('rating 4.6', 'price 14.62')).toEqual(['4.6']);
    expect(ungroundedNumbers('total 1234', 'order id 12345')).toEqual(['1234']);
  });
});
