// Tier-2 PII anonymization for cloud egress.
// Reversible. Replaces matches with placeholders, returns mapping table.

interface Pattern {
  kind: 'PERSON' | 'EMAIL' | 'PHONE' | 'ADDRESS' | 'CC' | 'SSN';
  re: RegExp;
  validate?: (m: string) => boolean;
}

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// SSN requires a separator so bare numeric IDs (tab IDs etc.) aren't matched.
const SSN_RE = /\b(?!000|666|9\d{2})\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b/g;
const PHONE_RE = /(?<!\d)(?:(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})(?!\d)/g;
const CC_RE = /\b(?:\d[ -]?){12,18}\d\b/g;
const ADDRESS_RE =
  /\b\d{1,6}\s+([A-Z][a-z]+\s)?(?:[A-Z][a-z]+\s){1,4}(St(?:reet)?|Ave(?:nue)?|Blvd|Boulevard|Rd|Road|Ln|Lane|Dr(?:ive)?|Ct|Court|Way|Pkwy|Parkway|Cir(?:cle)?|Pl(?:ace)?)\b\.?/g;
const PERSON_RE = /\b(?:Mr|Mrs|Ms|Dr|Prof)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g;

const PATTERNS: Pattern[] = [
  { kind: 'CC', re: CC_RE, validate: (s) => luhnValid(s.replace(/[ -]/g, '')) },
  { kind: 'SSN', re: SSN_RE },
  { kind: 'EMAIL', re: EMAIL_RE },
  { kind: 'PHONE', re: PHONE_RE },
  { kind: 'ADDRESS', re: ADDRESS_RE },
  { kind: 'PERSON', re: PERSON_RE },
];

export interface AnonResult {
  text: string;
  table: Record<string, string>;
}

export function anonymize(input: string): AnonResult {
  if (!input) return { text: input, table: {} };
  const table: Record<string, string> = {};
  const reverse = new Map<string, string>();
  const counters: Record<string, number> = {};
  let out = input;
  for (const p of PATTERNS) {
    out = out.replace(p.re, (m) => {
      if (p.validate && !p.validate(m)) return m;
      if (reverse.has(m)) return reverse.get(m)!;
      counters[p.kind] = (counters[p.kind] ?? -1) + 1;
      const tok = `<${p.kind}_${counters[p.kind]}>`;
      table[tok] = m;
      reverse.set(m, tok);
      return tok;
    });
  }
  return { text: out, table };
}

export class DeanonError extends Error {
  fatal = true as const;
  constructor(msg: string) {
    super(msg);
    this.name = 'DeanonError';
  }
}

const TOKEN_RE = /<(?:PERSON|EMAIL|PHONE|ADDRESS|CC|SSN)_\d+>/g;

export function deanonymize(text: string, table: Record<string, string>): string {
  if (!text) return text;
  return text.replace(TOKEN_RE, (tok) => {
    if (!(tok in table)) {
      throw new DeanonError(`Unknown anonymization token: ${tok}`);
    }
    return table[tok];
  });
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
