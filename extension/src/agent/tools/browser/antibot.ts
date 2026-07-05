// Anti-bot block detection — captchas, Cloudflare/Akamai-style interstitials, generic
// "unusual traffic"/access-denied walls. Deterministic text matching only: this never attempts
// to solve, click through, or otherwise interact with any of these — it only recognizes that
// one is present, so the orchestrator can pause and let a human resolve it in the visible tab.
// Solving/bypassing anti-bot mechanisms is explicitly out of scope for this project — see
// docs/superpowers/specs/2026-07-05-antibot-pause-design.md.

export interface AntiBotBlock {
  label: string;
}

interface Pattern {
  label: string;
  re: RegExp;
}

// Checked in order — a page could plausibly match more than one (e.g. a CAPTCHA widget whose
// caption also contains generic "verify you are human" phrasing); vendor-specific patterns are
// listed before generic ones so a positive vendor identification takes precedence.
const PATTERNS: Pattern[] = [
  {
    label: 'Cloudflare browser check',
    re: /checking your browser|ddos protection by cloudflare|cf-browser-verification/i,
  },
  {
    label: 'Google automated-traffic block',
    re: /unusual traffic from your computer network|our systems have detected unusual traffic/i,
  },
  { label: 'Akamai bot block', re: /pardon the interruption/i },
  { label: 'CAPTCHA widget', re: /\b(recaptcha|hcaptcha|cloudflare turnstile|arkose|funcaptcha)\b/i },
  {
    label: 'Generic human-verification wall',
    re: /verify you are human|i'm not a robot|are you a robot|please complete the security check/i,
  },
];

/** The anti-bot block present on this page, or null if none of the known patterns match.
 *  A miss is a false negative (no pause), never a false positive that would block a legitimate
 *  page — like findConsentDismiss, this is a starting pattern set, not an exhaustive one. If
 *  real-world false positives show up, tighten individual patterns then, not preemptively. */
export function detectAntiBotBlock(ariaText: string): AntiBotBlock | null {
  for (const p of PATTERNS) {
    if (p.re.test(ariaText)) return { label: p.label };
  }
  return null;
}
