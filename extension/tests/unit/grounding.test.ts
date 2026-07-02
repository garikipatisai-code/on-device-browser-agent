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
  it('is true for further realistic absence phrasings (regex generalizes beyond the seed cases)', () => {
    expect(mentionsMissing('Star rating: not shown.')).toBe(true);
    expect(mentionsMissing('Price: not displayed.')).toBe(true);
    expect(mentionsMissing('The SKU is not stated in the listing.')).toBe(true);
    expect(mentionsMissing('The review count is not specified on the product page.')).toBe(true);
    expect(mentionsMissing('The phone number is unavailable.')).toBe(true);
  });
  it('is false for a clean positive answer', () => {
    expect(mentionsMissing('Café: Court Café, open daily. Cloakroom: available. Wi-Fi: free throughout.')).toBe(false);
    expect(mentionsMissing('The phone number is +44 20 7323 8000')).toBe(false);
    expect(mentionsMissing('Shanghai has the largest population at 24,722,254')).toBe(false);
  });
  it('is false for a price/attribute comparison that merely contains "not listed/shown" (not an absence claim)', () => {
    expect(mentionsMissing("It's not listed at full price — it's on sale for $12.99.")).toBe(false);
    expect(mentionsMissing('The discount is not shown at checkout, only on the product page.')).toBe(false);
    expect(mentionsMissing('It is not available for pickup, only for delivery.')).toBe(false);
    expect(mentionsMissing('The item is not listed at the regular price, but it is on clearance for $4.99.')).toBe(false);
    expect(mentionsMissing('Free shipping is not offered at checkout for orders under $50.')).toBe(false);
  });
  it('still flags a genuine "on"-phrased absence claim, even one styled like a comparison (documents the deliberate scope boundary: "on" is ambiguous, so it stays a true-positive trigger rather than risk suppressing a real absence)', () => {
    expect(mentionsMissing('The badge is not shown on mobile, only on desktop.')).toBe(true);
    expect(mentionsMissing('Wi-Fi is not shown on the page, but the café is open daily.')).toBe(true);
  });
});
