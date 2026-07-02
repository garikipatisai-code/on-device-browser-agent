// Domain tier gating. Fail-closed: unknown hosts default to read-only.
import type { DomainTier } from '@/shared/messages';

export const TIER_ORDER: Record<DomainTier, number> = {
  'read-only': 0,
  'click-only': 1,
};

export class DomainTierError extends Error {
  fatal = true as const;
  constructor(message: string, public host: string, public required: DomainTier, public actual: DomainTier) {
    super(message);
    this.name = 'DomainTierError';
  }
}

const BLOCKED_PROTOCOLS = new Set([
  'file:',
  'chrome:',
  'chrome-extension:',
  'devtools:',
  'view-source:',
  'javascript:',
  'data:',
  'blob:',
  'about:',
  'ws:',
  'wss:',
]);

export function isBlockedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return BLOCKED_PROTOCOLS.has(u.protocol);
  } catch {
    return true;
  }
}

export function hostFor(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function getDomainTier(host: string, tiers: Record<string, DomainTier>): DomainTier {
  if (!host) return 'read-only';
  if (tiers[host]) return migrateLegacyTier(tiers[host]);
  const parts = host.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const suffix = parts.slice(i).join('.');
    if (tiers[suffix]) return migrateLegacyTier(tiers[suffix]);
  }
  return 'read-only';
}

/** Pre-collapse installs may have persisted the now-removed 'full-action' tier (it was byte-
 *  identical to 'click-only' in enforcement — see assertCanAct call sites, all hardcode
 *  'click-only'). Read it back as 'click-only', the closer/more-permissive of the two remaining
 *  tiers, so an existing grant isn't silently narrowed to read-only. Exported so the Settings UI
 *  can apply the same normalization when rendering a persisted value directly. */
export function migrateLegacyTier(tier: DomainTier): DomainTier {
  if ((tier as string) === 'full-action') return 'click-only';
  return tier;
}

export function assertCanAct(
  url: string,
  required: DomainTier,
  tiers: Record<string, DomainTier>,
  bypass = false,
): void {
  if (isBlockedUrl(url)) {
    throw new DomainTierError(`Blocked URL scheme: ${url}`, '', required, 'read-only');
  }
  // The opt-in bypass relaxes only the site-access tiers (read-only/click-only) — the protocol
  // blocklist above STILL applies (file:/chrome:/javascript: are security, not access).
  if (bypass) return;
  const host = hostFor(url);
  const actual = getDomainTier(host, tiers);
  if (TIER_ORDER[actual] < TIER_ORDER[required]) {
    throw new DomainTierError(
      `Cannot ${required} on ${host} (current tier: ${actual}). Upgrade this domain in Settings.`,
      host,
      required,
      actual,
    );
  }
}
