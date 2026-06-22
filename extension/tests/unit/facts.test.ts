import { describe, expect, it } from 'vitest';
import { addGroundedFact, renderFacts, groundingCorpus, type Fact } from '@/agent/facts';

const OBSERVED = 'Austin had a population of 961,855 in the 2020 census.';

describe('addGroundedFact', () => {
  it('adds a fact whose numbers all appear in observed text', () => {
    const out = addGroundedFact([], { step: 's', text: 'Austin population: 961,855' }, OBSERVED);
    expect(out).toHaveLength(1);
  });
  it('rejects a fact with a number not in observed text', () => {
    const out = addGroundedFact([], { step: 's', text: 'Austin population: 1,234,567' }, OBSERVED);
    expect(out).toHaveLength(0);
  });
  it('rejects a blank fact and a duplicate', () => {
    let out = addGroundedFact([], { step: 's', text: '   ' }, OBSERVED);
    expect(out).toHaveLength(0);
    out = addGroundedFact([{ step: 's', text: 'Austin population: 961,855' }], { step: 's', text: 'Austin population: 961,855' }, OBSERVED);
    expect(out).toHaveLength(1);
  });
  it('caps the ledger, dropping the oldest', () => {
    let facts: Fact[] = [];
    for (let i = 0; i < 30; i++) facts = addGroundedFact(facts, { step: 's', text: `fact number ${i} grounded` }, `fact number ${i} grounded`, 24);
    expect(facts).toHaveLength(24);
    expect(facts[0].text).toBe('fact number 6 grounded');
  });
  it('admits a fact with no numbers (no numeric claim to ground)', () => {
    const out = addGroundedFact([], { step: 's', text: 'Item is in stock' }, 'unrelated observed text');
    expect(out).toHaveLength(1);
  });
});

describe('renderFacts', () => {
  it('returns undefined for an empty ledger', () => {
    expect(renderFacts([])).toBeUndefined();
  });
  it('renders bullets with optional url and bounds length', () => {
    const block = renderFacts([{ step: 's', text: 'Austin: 961,855', url: 'https://x' }]);
    expect(block).toBe('- Austin: 961,855 [https://x]');
  });
  it('truncates to maxChars at a line boundary (top bullet not garbled)', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ step: 's', text: `fact ${i} value` }));
    const out = renderFacts(many, 20);
    expect(out).toBeDefined();
    expect(out!.length).toBeLessThanOrEqual(20);
    expect(out!.startsWith('- ')).toBe(true);
  });
});

describe('groundingCorpus', () => {
  it('includes fact texts so an evicted page still grounds the answer', () => {
    const corpus = groundingCorpus('', [{ step: 's', text: 'Denver: 715,522' }]);
    expect(corpus).toContain('715,522');
  });
  it('returns observed unchanged when facts list is empty', () => {
    expect(groundingCorpus('page text', [])).toBe('page text');
  });
});
