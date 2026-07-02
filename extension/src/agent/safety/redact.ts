// Tier-1 PII redaction. Applied at IndexedDB persistence boundary.
// Irreversible. Replaces matches with [REDACTED: <type>].

type Type = 'CC' | 'SSN' | 'EMAIL' | 'PHONE' | 'ADDRESS';

interface Pattern {
  type: Type;
  re: RegExp;
  validate?: (match: string) => boolean;
}

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// SSN requires a hyphen/space separator (123-45-6789), so it does NOT match
// bare numeric IDs like Chrome tab IDs (e.g. 668114221).
const SSN_RE = /\b(?!000|666|9\d{2})\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b/g;
// Phone: digit-boundary guards on both ends so a 10-digit window inside a
// longer numeric run (e.g. a tracking-URL token) isn't matched as a phone.
const PHONE_RE = /(?<!\d)(?:(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})(?!\d)/g;
// International numbers start with + and a country code; require enough digits so
// version strings like "+2.0.1" don't match.
const INTL_PHONE_RE = /(?<!\d)\+\d{1,3}[\s.-]?\d[\d\s.-]{5,14}\d(?!\d)/g;
const CC_CANDIDATE_RE = /\b(?:\d[ -]?){12,18}\d\b/g;
const ADDRESS_RE =
  /\b\d{1,6}\s+(?:[A-Za-z0-9'.]+\s){1,4}(?:St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Ln|Lane|Dr|Drive|Ct|Court|Way|Pkwy|Parkway|Cir|Circle|Pl|Place|Ter|Terrace|Loop|Sq|Square|Trl|Trail|Hwy|Highway)\b\.?/gi;

const PATTERNS: Pattern[] = [
  { type: 'CC', re: CC_CANDIDATE_RE, validate: (s) => luhnValid(s.replace(/[ -]/g, '')) },
  { type: 'SSN', re: SSN_RE },
  { type: 'EMAIL', re: EMAIL_RE },
  { type: 'PHONE', re: PHONE_RE },
  { type: 'PHONE', re: INTL_PHONE_RE },
  { type: 'ADDRESS', re: ADDRESS_RE },
];

export function redact(input: string): string {
  if (!input) return input;
  let out = input;
  for (const p of PATTERNS) {
    out = out.replace(p.re, (m) => {
      if (p.validate && !p.validate(m)) return m;
      return `[REDACTED: ${p.type}]`;
    });
  }
  return out;
}

/**
 * Redacts a TimelineEvent before it is persisted/emitted. This is the single chokepoint
 * every event flows through (see orchestrator.ts's emit()) — so no individual call site
 * needs its own redact() call, and no future TimelineEvent variant can reintroduce a PII leak.
 * Returns a new object; never mutates the input. Never throws.
 */
export function redactEvent<T>(ev: T): T {
  const e = ev as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...e };
  if ('args' in out) {
    try {
      out.args = JSON.parse(redact(JSON.stringify(out.args)));
    } catch {
      out.args = '[redacted]';
    }
  }
  if (typeof out.content === 'string') out.content = redact(out.content);
  if (typeof out.message === 'string') out.message = redact(out.message);
  return out as unknown as T;
}

export function redactDeep<T>(v: T): T {
  if (typeof v === 'string') return redact(v) as unknown as T;
  if (Array.isArray(v)) return v.map(redactDeep) as unknown as T;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) out[redact(k)] = redactDeep(val);
    return out as unknown as T;
  }
  return v;
}

export function luhnValid(num: string): boolean {
  if (!/^\d+$/.test(num) || num.length < 13 || num.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let n = Number.parseInt(num[i], 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}
