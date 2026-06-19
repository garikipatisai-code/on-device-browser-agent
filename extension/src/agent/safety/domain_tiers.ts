// Domain tier gating. Fail-closed: unknown hosts default to read-only.
import type { DomainTier } from '@/shared/messages';

export const TIER_ORDER: Record<DomainTier, number> = {
  'read-only': 0,
  'click-only': 1,
  'full-action': 2,
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
  if (tiers[host]) return tiers[host];
  const parts = host.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const suffix = parts.slice(i).join('.');
    if (tiers[suffix]) return tiers[suffix];
  }
  return 'read-only';
}

export function assertCanAct(
  url: string,
  required: DomainTier,
  tiers: Record<string, DomainTier>,
): void {
  if (isBlockedUrl(url)) {
    throw new DomainTierError(`Blocked URL scheme: ${url}`, '', required, 'read-only');
  }
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
