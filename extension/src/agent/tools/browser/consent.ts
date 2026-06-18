// Generic consent/cookie-wall dismissal — universal, no site-specific selectors.
// Detects a consent wall from the simplified ARIA text and returns the index of
// the button to click. Privacy-preferring: picks "Reject all"/"Necessary only"
// when present, falling back to "Accept" only if there's no reject option.
//
// Dual-signal guard against false positives: the page must show consent-context
// keywords AND expose a direct dismiss button. Buttons that merely open MORE
// options (manage/customize/settings) are never clicked.

export interface ConsentDismiss {
  index: number;
  label: string;
  kind: 'reject' | 'accept';
}

const CONSENT_CONTEXT =
  /\b(cookies?|consent|gdpr|tracking)\b|we value your privacy|your privacy|use of cookies|privacy (policy|choices|preferences|settings)|data protection/i;

// Buttons that open further choices rather than dismiss the wall → never click.
const IGNORE = /\b(manage|customi[sz]e|settings|preferences|options|more info|learn more)\b/i;

// Privacy-preserving dismissals, strongest first.
const REJECT_LABELS = [
  /\breject all\b/i,
  /\breject\b/i,
  /\bnecessary (cookies )?only\b/i,
  /\bonly necessary\b/i,
  /\bessential( cookies)? only\b/i,
  /\bdecline( all)?\b/i,
  /\bcontinue without\b/i,
];

// Accept-style fallbacks, strongest first.
const ACCEPT_LABELS = [
  /\baccept all\b/i,
  /\baccept( cookies)?\b/i,
  /\bagree( all)?\b/i,
  /\bi agree\b/i,
  /\ballow all\b/i,
  /\ballow\b/i,
  /\bgot it\b/i,
  /\bunderstood\b/i,
  /\bok\b/i,
];

// Indexed interactive line in the serialized tree: `[3] button "Accept all"`.
const EL_RE = /\[(\d+)\]\s+[\w-]+\s+"([^"]*)"/g;

interface El {
  index: number;
  name: string;
}

function interactiveElements(text: string): El[] {
  const out: El[] = [];
  let m: RegExpExecArray | null;
  EL_RE.lastIndex = 0;
  while ((m = EL_RE.exec(text)) !== null) out.push({ index: Number(m[1]), name: m[2] });
  return out;
}

function firstMatch(els: El[], labels: RegExp[]): El | null {
  for (const re of labels) {
    const el = els.find((e) => re.test(e.name) && !IGNORE.test(e.name));
    if (el) return el;
  }
  return null;
}

/** The dismiss button to click on a consent wall, or null if this isn't one
 *  (or there's no safe direct dismiss). */
export function findConsentDismiss(ariaText: string): ConsentDismiss | null {
  if (!CONSENT_CONTEXT.test(ariaText)) return null;
  const els = interactiveElements(ariaText);
  const reject = firstMatch(els, REJECT_LABELS);
  if (reject) return { index: reject.index, label: reject.name, kind: 'reject' };
  const accept = firstMatch(els, ACCEPT_LABELS);
  if (accept) return { index: accept.index, label: accept.name, kind: 'accept' };
  return null;
}
