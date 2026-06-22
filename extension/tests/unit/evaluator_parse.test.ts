import { describe, expect, it } from 'vitest';
import { parseVerdict } from '@/agent/roles/evaluator';

describe('parseVerdict', () => {
  it('extracts a fact from clean JSON', () => {
    const v = parseVerdict('{"verdict":"PASS","reason":"ok","shouldReplan":false,"finishVerdict":null,"finishSummary":null,"fact":"Austin population: 961,855"}');
    expect(v.verdict).toBe('PASS');
    expect(v.fact).toBe('Austin population: 961,855');
  });
  it('returns fact=null when absent or blank', () => {
    expect(parseVerdict('{"verdict":"PASS"}').fact).toBeNull();
    expect(parseVerdict('{"verdict":"PASS","fact":"   "}').fact).toBeNull();
  });
  it('still salvages PASS/FAIL from a truncated body (fact stays null)', () => {
    const v = parseVerdict('{"verdict":"PASS","reason":"the value 961,8');
    expect(v.verdict).toBe('PASS');
    expect(v.fact).toBeNull();
  });
});
