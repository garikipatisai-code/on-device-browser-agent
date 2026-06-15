import { describe, expect, it } from 'vitest';
import {
  assertCanAct,
  DomainTierError,
  getDomainTier,
  hostFor,
  isBlockedUrl,
  TIER_ORDER,
} from '@/agent/safety/domain_tiers';

describe('domain_tiers — defaults', () => {
  it('unknown host → read-only', () => {
    expect(getDomainTier('example.com', {})).toBe('read-only');
  });
  it('exact match wins', () => {
    expect(getDomainTier('amazon.com', { 'amazon.com': 'click-only' })).toBe('click-only');
  });
  it('suffix match (parent domain)', () => {
    expect(getDomainTier('smile.amazon.com', { 'amazon.com': 'full-action' })).toBe('full-action');
  });
});

describe('TIER_ORDER', () => {
  it('is monotonic', () => {
    expect(TIER_ORDER['read-only']).toBeLessThan(TIER_ORDER['click-only']);
    expect(TIER_ORDER['click-only']).toBeLessThan(TIER_ORDER['full-action']);
  });
});

describe('assertCanAct', () => {
  it('blocks read-only host from click action', () => {
    expect(() => assertCanAct('https://unknown.com/page', 'click-only', {})).toThrow(DomainTierError);
  });
  it('allows click-only host for click action', () => {
    expect(() =>
      assertCanAct('https://amazon.com/p/123', 'click-only', { 'amazon.com': 'click-only' }),
    ).not.toThrow();
  });
  it('blocks click-only host from full-action', () => {
    expect(() =>
      assertCanAct('https://amazon.com/p/123', 'full-action', { 'amazon.com': 'click-only' }),
    ).toThrow(DomainTierError);
  });
  it('blocks chrome:// urls', () => {
    expect(() => assertCanAct('chrome://extensions', 'read-only', {})).toThrow(DomainTierError);
  });
  it('blocks file:// urls', () => {
    expect(() => assertCanAct('file:///etc/passwd', 'read-only', {})).toThrow(DomainTierError);
  });
});

describe('isBlockedUrl / hostFor', () => {
  it('blocks dangerous protocols', () => {
    expect(isBlockedUrl('chrome://settings')).toBe(true);
    expect(isBlockedUrl('chrome-extension://abc/foo')).toBe(true);
    expect(isBlockedUrl('file:///tmp')).toBe(true);
    expect(isBlockedUrl('devtools://devtools')).toBe(true);
  });
  it('allows http(s)', () => {
    expect(isBlockedUrl('https://example.com')).toBe(false);
    expect(isBlockedUrl('http://example.com')).toBe(false);
  });
  it('extracts host', () => {
    expect(hostFor('https://Foo.Bar.com/path')).toBe('foo.bar.com');
  });
});
