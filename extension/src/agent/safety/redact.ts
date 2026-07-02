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
 *
 * Recursively redacts every STRING VALUE in the event, at any depth, in objects or arrays —
 * numbers/booleans/null/undefined are returned as-is and never touch the regex. This closes
 * the bug class structurally (no per-field checklist to forget a field on — closed three rounds
 * of "one more field missed": evaluator.verdict.reason / finish.summary, then finish.sources,
 * a string[] that a `typeof === 'string'` guard could never catch).
 *
 * Earlier version stringified the WHOLE event (including numbers) to JSON text and ran redact()
 * over that text, then re-parsed. That collided with CC_CANDIDATE_RE: every event's `ts` field is
 * a 13-digit Date.now() value, and ~10% of any timestamp range passes the Luhn checksum by pure
 * chance (measured over 100k consecutive real timestamps) — a false CC match replaces the numeric
 * literal with an unquoted `[REDACTED: CC]` token, corrupting the JSON and losing the whole event
 * to the parse-failure fallback. The walker below fixes this at the actual root cause: a number
 * is never coerced to a string in the first place, so the regex never sees it — zero collision
 * risk, not a narrower one, and no change to redact()/CC_CANDIDATE_RE (so every other caller of
 * redact() is unaffected).
 *
 * Depth-capped (8) as a guard against unbounded recursion; TimelineEvent data (tool args/results,
 * LLM-generated strings) is plain JSON-shaped and never contains a live circular object reference
 * in practice, so this is a depth guard, not a cycle detector — see the test file for why a
 * circular-ref scenario isn't exercised here.
 *
 * Returns a new object; never mutates the input. Never throws.
 */
function redactValue(v: unknown, depth = 0): unknown {
  if (depth > 8) return '[redacted: too deep]';
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, depth + 1));
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, redactValue(val, depth + 1)]));
  }
  return v; // number, boolean, null, undefined — never touched, never at risk of a regex collision
}

export function redactEvent<T>(ev: T): T {
  return redactValue(ev) as T;
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
