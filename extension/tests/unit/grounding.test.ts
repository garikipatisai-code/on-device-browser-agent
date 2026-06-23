import { describe, expect, it } from 'vitest';
import { mentionsMissing } from '@/agent/verify/grounding';

describe('mentionsMissing — detects a "requested field is absent" claim in a finish summary', () => {
  it('is true for negative-availability phrasings', () => {
    expect(mentionsMissing('Café: not listed.')).toBe(true);
    expect(mentionsMissing('Wi-Fi: not shown on the page')).toBe(true);
    expect(mentionsMissing('The phone number is not available')).toBe(true);
    expect(mentionsMissing("couldn't find the opening hours")).toBe(true);
    expect(mentionsMissing('could not find a cloakroom')).toBe(true);
    expect(mentionsMissing('no mention of Wi-Fi')).toBe(true);
    expect(mentionsMissing('the page does not list a café')).toBe(true);
    expect(mentionsMissing('hours were not provided')).toBe(true);
  });
  it('is false for a clean positive answer', () => {
    expect(mentionsMissing('Café: Court Café, open daily. Cloakroom: available. Wi-Fi: free throughout.')).toBe(false);
    expect(mentionsMissing('The phone number is +44 20 7323 8000')).toBe(false);
    expect(mentionsMissing('Shanghai has the largest population at 24,722,254')).toBe(false);
  });
});
