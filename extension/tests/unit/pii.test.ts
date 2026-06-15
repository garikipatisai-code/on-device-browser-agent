import { describe, expect, it } from 'vitest';
import { redact, redactDeep, luhnValid } from '@/agent/safety/redact';
import { anonymize, deanonymize, DeanonError } from '@/agent/safety/anonymize';

describe('redact', () => {
  it('redacts email', () => {
    expect(redact('contact me at john.doe@example.com')).toContain('[REDACTED: EMAIL]');
  });
  it('redacts SSN-shaped numbers', () => {
    expect(redact('SSN 123-45-6789 here')).toContain('[REDACTED: SSN]');
    expect(redact('SSN 123 45 6789 here')).toContain('[REDACTED: SSN]');
  });
  it('does not redact SSN with starting 000/666', () => {
    expect(redact('id 000-12-3456')).not.toContain('[REDACTED: SSN]');
  });
  it('does NOT redact bare 9-digit IDs as SSN (e.g. Chrome tab IDs)', () => {
    // Regression: tabId 668114221 was being redacted as [REDACTED: SSN].
    expect(redact('Opened tab 668114221 at https://amazon.com')).toBe(
      'Opened tab 668114221 at https://amazon.com',
    );
    expect(redact('tabId 123456789 here')).not.toContain('[REDACTED');
  });
  it('redacts phone (US format)', () => {
    expect(redact('call (415) 555-1234 today')).toContain('[REDACTED: PHONE]');
    expect(redact('+1 415 555 1234')).toContain('[REDACTED: PHONE]');
  });
  it('does NOT redact a 10-digit slice inside a longer numeric run', () => {
    // Regression: a tracking-URL token like vqd=4-28267483284794670302242853934
    // had a 10-digit window redacted as [REDACTED: PHONE].
    expect(redact('vqd=4-28267483284794670302242853934&x')).not.toContain('[REDACTED');
  });
  it('redacts CC only when Luhn-valid', () => {
    expect(redact('card 4242 4242 4242 4242 here')).toContain('[REDACTED: CC]');
    expect(redact('card 1234 5678 9012 3456 here')).not.toContain('[REDACTED: CC]');
  });
  it('is idempotent', () => {
    const once = redact('email a@b.com and 415-555-1234');
    expect(redact(once)).toBe(once);
  });
  it('leaves normal text alone', () => {
    expect(redact('Hello world, the price is $29.99')).toBe('Hello world, the price is $29.99');
  });
});

describe('redactDeep', () => {
  it('walks into objects and arrays', () => {
    const r = redactDeep({ msg: 'a@b.com', nested: ['call 415-555-1234'] });
    expect(JSON.stringify(r)).toContain('[REDACTED: EMAIL]');
    expect(JSON.stringify(r)).toContain('[REDACTED: PHONE]');
  });
});

describe('luhnValid', () => {
  it('passes known test cards', () => {
    expect(luhnValid('4242424242424242')).toBe(true);
    expect(luhnValid('4111111111111111')).toBe(true);
  });
  it('rejects invalid digits', () => {
    expect(luhnValid('4242424242424241')).toBe(false);
    expect(luhnValid('abc')).toBe(false);
    expect(luhnValid('1')).toBe(false);
  });
});

describe('anonymize / deanonymize', () => {
  it('round-trips emails', () => {
    const { text, table } = anonymize('email a@b.com and c@d.com');
    expect(text).not.toContain('a@b.com');
    expect(deanonymize(text, table)).toBe('email a@b.com and c@d.com');
  });
  it('round-trips multiple types', () => {
    const input = 'Mr. John Smith at john@x.com, phone 415-555-1234, address 123 Main Street.';
    const { text, table } = anonymize(input);
    expect(text).not.toContain('john@x.com');
    expect(text).not.toContain('415-555-1234');
    expect(deanonymize(text, table)).toBe(input);
  });
  it('reuses placeholders for repeated values', () => {
    const { text } = anonymize('a@b.com and again a@b.com');
    const tokens = text.match(/<EMAIL_\d+>/g)!;
    expect(tokens[0]).toBe(tokens[1]);
  });
  it('throws DeanonError on unknown token', () => {
    expect(() => deanonymize('hello <EMAIL_99> world', {})).toThrow(DeanonError);
  });
  it('leaves non-PII alone', () => {
    const { text } = anonymize('hello world');
    expect(text).toBe('hello world');
  });
});
