import { describe, expect, it } from 'vitest';
import { redact, redactDeep } from '@/agent/safety/redact';

describe('redact — broader coverage (audit gaps)', () => {
  it('redacts international (+country-code) phone numbers', () => {
    expect(redact('call +44 20 7946 0958 today')).toContain('[REDACTED: PHONE]');
    expect(redact('phone +91 98765 43210')).toContain('[REDACTED: PHONE]');
  });

  it('does not over-redact version strings as phones', () => {
    expect(redact('upgraded to +2.0.1 release')).not.toContain('[REDACTED: PHONE]');
  });

  it('redacts ordinal / extended / lowercase street addresses', () => {
    expect(redact('I live at 350 5th Ave')).toContain('[REDACTED: ADDRESS]');
    expect(redact('742 Evergreen Terrace')).toContain('[REDACTED: ADDRESS]');
    expect(redact('1 Infinite Loop, Cupertino')).toContain('[REDACTED: ADDRESS]');
    expect(redact('123 main st')).toContain('[REDACTED: ADDRESS]');
  });

  it('redactDeep scrubs PII in object KEYS, not just values', () => {
    const out = redactDeep({ 'contact a@b.com': 'note' });
    expect(JSON.stringify(out)).toContain('[REDACTED: EMAIL]');
  });
});
