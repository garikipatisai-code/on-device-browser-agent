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
  it('is true for a genuine absence claim that happens to use "at/for" non-comparatively (code review regression: a bare at/for exclusion wrongly suppressed these)', () => {
    expect(mentionsMissing('Wi-Fi is not listed at this time.')).toBe(true);
    expect(mentionsMissing('Hours are not available at this time.')).toBe(true);
    expect(mentionsMissing('The SKU was not found at this location.')).toBe(true);
    expect(mentionsMissing('not listed at all on the site.')).toBe(true);
    expect(mentionsMissing('Price is not listed at the moment.')).toBe(true);
    // a real absence claim followed much later by an unrelated remark that happens to start
    // with "but" must NOT be suppressed — "but" alone, far from "at/for", is not comparison
    // evidence (same asymmetry as the "on" exclusion: err toward not suppressing).
    expect(mentionsMissing('The SKU is not found at this location, but the store still has other items in stock.')).toBe(true);
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
  it('documents the residual: a comparison phrased WITHOUT any marker word ($ figure / only / instead / on sale / however) still over-triggers — this is the accepted, harmless direction (one extra corpus-check call), not a fix for every possible comparison phrasing', () => {
    expect(mentionsMissing('It is not listed at the member price; non-members pay the standard rate.')).toBe(true);
    expect(mentionsMissing('The item is not available for same-day delivery — choose standard shipping for that.')).toBe(true);
    expect(mentionsMissing('The rating is not shown for verified buyers; it is visible to everyone else.')).toBe(true);
  });
});
