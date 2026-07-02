import { describe, expect, it } from 'vitest';
import type { DomainTier } from '@/shared/messages';
import {
  assertCanAct,
  DomainTierError,
  getDomainTier,
  hostFor,
  isBlockedUrl,
  TIER_ORDER,
} from '@/agent/safety/domain_tiers';

describe('domain_tiers — blocked protocols', () => {
  it('blocks dangerous URL schemes (javascript/data/blob/about/ws)', () => {
    expect(isBlockedUrl('javascript:alert(1)')).toBe(true);
    expect(isBlockedUrl('data:text/html,<script>x</script>')).toBe(true);
    expect(isBlockedUrl('blob:https://x/abc')).toBe(true);
    expect(isBlockedUrl('about:blank')).toBe(true);
    expect(isBlockedUrl('ws://evil')).toBe(true);
  });
  it('still allows normal http(s) URLs', () => {
    expect(isBlockedUrl('https://example.com')).toBe(false);
    expect(isBlockedUrl('http://example.com/page')).toBe(false);
  });
});

describe('domain_tiers — defaults', () => {
  it('unknown host → read-only', () => {
    expect(getDomainTier('example.com', {})).toBe('read-only');
  });
  it('exact match wins', () => {
    expect(getDomainTier('amazon.com', { 'amazon.com': 'click-only' })).toBe('click-only');
  });
  it('suffix match (parent domain)', () => {
    expect(getDomainTier('smile.amazon.com', { 'amazon.com': 'click-only' })).toBe('click-only');
  });
  it('migrates a pre-collapse "full-action" value read from storage to click-only', () => {
    // Pre-migration users could have persisted 'full-action' for a host. It must read back as
    // click-only (the closer/more-permissive of the two remaining tiers), not crash, and not
    // silently downgrade to read-only (that would be a security regression: it would revoke
    // click/type access an existing user had already granted).
    const legacyTiers = { 'amazon.com': 'full-action' } as unknown as Record<string, DomainTier>;
    expect(getDomainTier('amazon.com', legacyTiers)).toBe('click-only');
  });
  it('migrates a legacy "full-action" value reached via suffix match too', () => {
    const legacyTiers = { 'amazon.com': 'full-action' } as unknown as Record<string, DomainTier>;
    expect(getDomainTier('smile.amazon.com', legacyTiers)).toBe('click-only');
  });
});

describe('TIER_ORDER', () => {
  it('is monotonic', () => {
    expect(TIER_ORDER['read-only']).toBeLessThan(TIER_ORDER['click-only']);
  });
  it('has exactly the two live tiers', () => {
    expect(Object.keys(TIER_ORDER).sort()).toEqual(['click-only', 'read-only']);
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
  it('a legacy "full-action" host also satisfies a click-only requirement (migrates, not stricter)', () => {
    const legacyTiers = { 'amazon.com': 'full-action' } as unknown as Record<string, DomainTier>;
    expect(() => assertCanAct('https://amazon.com/p/123', 'click-only', legacyTiers)).not.toThrow();
  });
  it('blocks chrome:// urls', () => {
    expect(() => assertCanAct('chrome://extensions', 'read-only', {})).toThrow(DomainTierError);
  });
  it('blocks file:// urls', () => {
    expect(() => assertCanAct('file:///etc/passwd', 'read-only', {})).toThrow(DomainTierError);
  });
});

describe('assertCanAct — bypass', () => {
  it('skips the tier check on a read-only host when bypass is true', () => {
    expect(() => assertCanAct('https://unknown.com/page', 'click-only', {}, true)).not.toThrow();
  });
  it('STILL blocks dangerous URL schemes even when bypass is true', () => {
    expect(() => assertCanAct('javascript:alert(1)', 'click-only', {}, true)).toThrow(DomainTierError);
    expect(() => assertCanAct('file:///etc/passwd', 'click-only', {}, true)).toThrow(DomainTierError);
    expect(() => assertCanAct('chrome://extensions', 'click-only', {}, true)).toThrow(DomainTierError);
  });
  it('bypass defaults to false — read-only host still blocked', () => {
    expect(() => assertCanAct('https://unknown.com/page', 'click-only', {})).toThrow(DomainTierError);
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
