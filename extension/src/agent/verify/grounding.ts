// Pure grounding helpers shared by the live finish-verifier and the benchmark scorer.
// "Grounded" = every number an answer asserts actually appeared in the text the agent
// read. Bare single digits ("1.", "top 3") are intentionally NOT treated as data, so
// list markers never look like hallucinations.

const NUM_RE = /\$\s?\d[\d,]*(?:\.\d+)?|\b\d+\.\d+\b|\b\d{2,}\b/g;

/** Single match-extraction helper shared by every number/entity extractor below. */
function extractMatches(re: RegExp, text: string): string[] {
  return text.match(re) ?? [];
}

export function normNum(tok: string): string {
  return tok.replace(/[$\s,]/g, '');
}

export function dataNumbers(s: string): string[] {
  return [...new Set(extractMatches(NUM_RE, s).map(normNum))];
}

/** Numbers in `text` that do NOT appear anywhere in `observed`. Matches whole
 *  normalized numbers (set membership), NOT raw substrings — so a claimed "4.6"
 *  is NOT considered grounded just because the page said "14.62".
 *
 *  NOTE (T2 unification): this is the legacy number-only check used by the
 *  benchmark scorer. It has NO percent equivalence (0.5 vs 50% do NOT match
 *  here). The authoritative finish-gate check is
 *  `assertNumbersEntitiesGrounded`, which treats 0.5 ≡ 50% and additionally
 *  grounds Capitalized entities. */
export function ungroundedNumbers(text: string, observed: string): string[] {
  const obs = new Set(dataNumbers(observed));
  return dataNumbers(text).filter((n) => !obs.has(n));
}

// A finish that claims a requested field is ABSENT. Used to trigger a re-answer from the full
// observed corpus: the agent may have moved past the page/snippet that actually had the field.
//
// The negative lookahead after "not (listed|shown|...)" suppresses a match only on POSITIVE
// evidence of a price/attribute comparison, not on the bare presence of "at/for" — an earlier
// version excluded on "at/for" alone and wrongly suppressed genuine absence claims like "not
// listed at this time" / "not available at the moment" / "not found at this location" (code
// review caught this: those have no comparison, just a bare temporal/locative "at").
//
// The marker list went through two more rounds of code review after that: "only"/"instead"/
// "however" were each tried as comparison evidence, and each was found to ALSO occur naturally
// in a genuine absence claim followed by a redirect to an alternative source — e.g. "Wi-Fi is
// not listed at reception; check the front desk instead." (a real absence, not a value-vs-value
// comparison) is indistinguishable, by bare word alone, from "not available for pickup, only
// for delivery" (a real comparison). Every bare single connective word tried ("on", "but",
// "only", "however", "instead") turned out to be too polysemous to trust. So the marker list is
// now restricted to the two signals that are structurally unambiguous — they essentially never
// occur except inside a genuine price/attribute comparison: an actual currency figure
// (`\$\s?\d`), or the fixed multi-word phrase "on sale". The lookahead's scan window is also
// bounded by `;` in addition to `.!?`, since a semicolon is as strong a clause boundary as a
// full stop for this purpose (this closes off e.g. a price mentioned for an unrelated item two
// clauses later coincidentally suppressing an absence claim about a different field).
//
// This intentionally UNDER-suppresses rather than over-suppresses: a comparison phrased without
// a currency figure or "on sale" — including ones that use "only"/"instead"/"however" — still
// over-triggers mentionsMissing (returns true). That costs one harmless extra corpus-recheck
// call — the original, narrower bug this fix targets. The opposite error (suppressing a genuine
// absence claim) is worse: it would silently skip the honesty check entirely. See
// grounding.test.ts for the full case matrix, including the documented residual.
//
// Known remaining gap (the unsafe direction, left open deliberately): an absence claim about one
// field and an unrelated "$"/"on sale" mention about a DIFFERENT field can still coincidentally
// land in the same comma-joined clause within the 60-char window, e.g. "Wi-Fi password is not
// listed at the front desk, but rooms start at $89 a night." wrongly suppresses. Widening the
// clause boundary to also break on "," (mirroring the ";" fix above) is NOT a free fix: comma is
// also the connector the accepted comparison phrasing itself relies on ("...at Y, but/on Z"), so
// it just relocates the same blind spot rather than closing it. Left as a documented residual
// rather than chased further.
const MISSING_RE =
  /\bnot (listed|shown|available|provided|mentioned|specified|found|displayed|stated)(?!\s+(?:at|for)\b(?=[^.!?;]{0,60}(?:\$\s?\d|\bon sale\b)))\b|\b(could ?n'?t|can ?not|could not|unable to) (find|locate)\b|\bno mention\b|\bdo(es)?(?: ?n'?t| not) (list|mention|show|include|provide|state)\b|\bunavailable\b/i;

/** True if a finish summary claims a requested field is missing/absent. */
export function mentionsMissing(text: string): boolean {
  return MISSING_RE.test(text);
}

// ── Proper-noun grounding (entity-level honesty check) ────────────────────────────
// Number-grounding can't catch a fabricated NAME ("per the Smithsonian report…" when no
// such source was read). This is a deliberately mechanical NLI-lite: extract multi-word
// proper-noun phrases from an answer and require each to appear (case-insensitively)
// somewhere in the observed corpus. Same design constraints as ungroundedNumbers: pure,
// deterministic, cheap — and biased to UNDER-flag rather than over-flag (a missed
// fabrication costs one honest gap; a false accusation poisons trust in the whole check).

/** Words that commonly start sentences or appear capitalized without being names. */
const PN_STOPWORDS = new Set([
  'The', 'A', 'An', 'This', 'That', 'These', 'Those', 'It', 'Its', 'In', 'On', 'At', 'For',
  'With', 'And', 'But', 'If', 'As', 'Is', 'Are', 'Was', 'Were', 'Be', 'To', 'Of', 'From',
  'By', 'Or', 'Not', 'No', 'When', 'While', 'There', 'Here', 'We', 'You', 'They', 'He',
  'She', 'His', 'Her', 'Their', 'Our', 'Your', 'My', 'Do', 'Does', 'Did', 'Has', 'Have',
  'Had', 'Can', 'Could', 'Should', 'Would', 'Will', 'May', 'Might', 'Must', 'Per', 'Vs',
  'Via', 'Also', 'However', 'All', 'Any', 'Some', 'Both', 'Each', 'Every', 'Other', 'More',
  'Most', 'Less', 'Least', 'First', 'Next', 'Last', 'Then', 'So', 'What', 'Which', 'Who',
]);

function isProperToken(t: string): boolean {
  return /^[A-Z][A-Za-z0-9&'.-]*$/.test(t);
}

/**
 * Multi-word proper-noun phrases in `text` (2+ consecutive capitalized tokens,
 * leading/trailing stopwords trimmed). Single words are intentionally excluded —
 * sentence-initial capitalization makes them too noisy to ground on.
 */
export function properNounPhrases(text: string): string[] {
  const raw = text.split(/\s+/);
  const out: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    while (run.length && PN_STOPWORDS.has(run[0])) run.shift();
    while (run.length && PN_STOPWORDS.has(run[run.length - 1])) run.pop();
    if (run.length >= 2) out.push(run.join(' '));
    run = [];
  };
  for (const r of raw) {
    // strip edge punctuation but keep internal .'- & digits (M185, O'Reilly, Wi-Fi).
    // Trailing '.'/'%' are stripped too — sentence-final periods must not turn
    // "Toms Hardware." into a phrase the corpus (ending "Toms Hardware") lacks.
    const t = r.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9%]+$/g, '');
    if (isProperToken(t)) run.push(t);
    else flush();
  }
  flush();
  return [...new Set(out)];
}

/**
 * Proper-noun phrases asserted in `text` that appear NOWHERE in `observed`
 * (case-insensitive substring). These are candidate fabricated entities — callers decide
 * whether that fails a score or just warns.
 *
 * LIVE USE: kept for the benchmark scorer (`tests/bench/scorer.ts`) and covered by
 * `grounding_entities.test.ts`. The T2 finish gate below intentionally does NOT
 * reuse this phrase-substring check: it is whitespace-sensitive ("Logitech    M185"
 * would miss "Logitech M185"), so the gate uses the whitespace-insensitive
 * single-token check (`extractEntityTokens` + `isEntityGrounded`) instead.
 */
export function ungroundedProperNouns(text: string, observed: string): string[] {
  const obs = observed.toLowerCase();
  return properNounPhrases(text).filter((p) => !obs.includes(p.toLowerCase()));
}

// ── Finish gate (fail-closed, BRAIN-only, 0 LLM calls) ───────────────────────
// Deterministic admission check for a `finish` call: missing args, ungrounded
// numbers, or a missing/failed post-state check all yield FAIL_CLOSED. Only a
// well-formed, grounded answer with an explicit post-state pass yields OK.
// Pure + synchronous by construction: no provider/LLM import, no I/O.

/** Fail-closed finish-gate decision. */
export type FinishGateDecision = 'OK' | 'FAIL_CLOSED';

/** Result of the finish gate. `ok` mirrors `decision === 'OK'` for callers. */
export interface FinishGateResult {
  decision: FinishGateDecision;
  ok: boolean;
  reason: string;
}

/** Minimal `finish` args admitted by the gate. */
export interface FinishArgs {
  verdict?: unknown;
  summary?: unknown;
}

/** Normalized post-state (e.g. from a `page.expect` check). */
export interface PostState {
  passed: boolean;
  detail?: string;
}

const FINISH_VERDICTS = new Set(['success', 'partial', 'blocked', 'failed']);

function failClosed(reason: string): FinishGateResult {
  return { decision: 'FAIL_CLOSED', ok: false, reason };
}

/** Normalize a raw post-state check fail-closed: anything but an explicit
 *  `{ passed: true }` becomes `{ passed: false }`. */
export function getPostState(
  input: { passed?: unknown; detail?: unknown } | null | undefined,
): PostState {
  if (!input || input.passed !== true) {
    return {
      passed: false,
      detail: typeof input?.detail === 'string' && input.detail ? input.detail : 'post-state check failed',
    };
  }
  return { passed: true, detail: typeof input.detail === 'string' ? input.detail : '' };
}

/** Fail-closed admission for a `finish`: args present + valid, post-state
 *  explicitly passed, and every number/entity in the summary grounded in
 *  `observed` via the T2 gate (`assertNumbersEntitiesGrounded`). Grounding
 *  applies regardless of verdict — `blocked`/`failed` carry no exemption
 *  (an ungrounded value in any summary still fails closed). */
export function isFinishAdmissible(
  args: FinishArgs | null | undefined,
  observed: string | null | undefined,
  postState?: PostState | null,
): FinishGateResult {
  if (!args || typeof args !== 'object') return failClosed('missing finish args');
  const verdict = typeof args.verdict === 'string' ? args.verdict : '';
  if (!FINISH_VERDICTS.has(verdict)) return failClosed('missing/invalid finish verdict');
  const summary = typeof args.summary === 'string' ? args.summary : '';
  if (!summary.trim()) return failClosed('missing finish summary');
  if (!postState || postState.passed !== true) return failClosed('post-state check failed');
  const t2 = assertNumbersEntitiesGrounded(summary, observed ?? '');
  if (!t2.ok) {
    return failClosed(`value(s) not found on any page read: ${t2.ungrounded.join(', ')}`);
  }
  return { decision: 'OK', ok: true, reason: '' };
}

// ── Number+entity grounding gate (T2, BRAIN-only, 0 LLM calls) ──────────
// Deterministic re-ground check: every number and Capitalized token asserted
// in `summary` must substring-match `observed` (whitespace-insensitive).
// Bare single digits are NOT data ("top 3", "1." list markers never flag) —
// only decimals, multi-digit numbers, percents (including single-digit like
// "5%"), and $-figures extract. Percent note: 0.5 ≡ 50% — a plain decimal and
// its ×100 percent form count as the same value. Anything else ungrounded
// yields RE_GROUND. An empty/whitespace-only summary also yields RE_GROUND
// (fail-closed: a vacuous summary grounds nothing). Pure: no imports, no I/O,
// no LLM calls. Number/entity extraction shares the single `extractMatches`
// helper with `dataNumbers` above.

/** Fail-closed re-ground decision for ungrounded numbers/entities. */
export type NumberEntityGroundingDecision = 'OK' | 'RE_GROUND';

/** Result of the number+entity grounding check. */
export interface NumberEntityGroundingResult {
  decision: NumberEntityGroundingDecision;
  ok: boolean;
  reason: string;
  ungrounded: string[];
}

const GATE_NUM_RE = /\$\s?\d[\d,]*(?:\.\d+)?\s?%?|\b\d+(?:\.\d+)?\s?%|\b\d+\.\d+\b|\b\d{2,}\b/g;

const CAPITALIZED_RE = /\b[A-Z][A-Za-z0-9&'.-]*\b/g;

function gateNumValue(tok: string): number | null {
  const n = parseFloat(tok.replace(/[$\s,%]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function isPercentEquivalent(summaryTok: string, obsTok: string): boolean {
  const sv = gateNumValue(summaryTok);
  const ov = gateNumValue(obsTok);
  if (sv === null || ov === null) return false;
  const sPct = /%/.test(summaryTok);
  const oPct = /%/.test(obsTok);
  if (sPct === oPct) return false;
  if (!sPct && oPct) return Math.abs(sv * 100 - ov) < 1e-9;
  return Math.abs(sv - ov * 100) < 1e-9;
}

function isNumberGrounded(tok: string, observed: string, obsNumToks: string[]): boolean {
  const obsNorm = observed.toLowerCase().replace(/[$,]/g, '').replace(/\s+/g, '');
  const tokNorm = tok.toLowerCase().replace(/[$,]/g, '').replace(/\s+/g, '');
  if (tokNorm && obsNorm.includes(tokNorm)) return true;
  for (const o of obsNumToks) {
    if (isPercentEquivalent(tok, o)) return true;
  }
  return false;
}

function isEntityGrounded(tok: string, observed: string): boolean {
  const obsFlat = observed.toLowerCase().replace(/\s+/g, '');
  const tokFlat = tok.toLowerCase().replace(/\s+/g, '');
  return tokFlat.length > 0 && obsFlat.includes(tokFlat);
}

/** Single entity-token extractor for the T2 gate: Capitalized tokens of length
 *  2+ outside the sentence-starter stopwords. Single letters and stopwords
 *  ("A", "The", "Per") are not entities. */
function extractEntityTokens(summary: string): string[] {
  return [...new Set(extractMatches(CAPITALIZED_RE, summary))].filter(
    (t) => t.length > 1 && !PN_STOPWORDS.has(t),
  );
}

/** Every number + Capitalized token in `summary` must appear in `observed`
 *  (whitespace-insensitive, 0.5≡50%). Returns RE_GROUND on any novel
 *  number/noun — or on an empty summary — else OK. */
export function assertNumbersEntitiesGrounded(
  summary: string,
  observed: string,
): NumberEntityGroundingResult {
  const s = summary ?? '';
  const o = observed ?? '';
  if (!s.trim()) {
    return { decision: 'RE_GROUND', ok: false, reason: 'ungrounded: empty summary', ungrounded: [''] };
  }
  const numToks = extractMatches(GATE_NUM_RE, s);
  const capToks = extractEntityTokens(s);
  const obsNumToks = extractMatches(GATE_NUM_RE, o);
  const ungrounded: string[] = [];
  for (const t of [...new Set(numToks)]) {
    if (!isNumberGrounded(t, o, obsNumToks)) ungrounded.push(t);
  }
  for (const t of capToks) {
    if (!isEntityGrounded(t, o)) ungrounded.push(t);
  }
  if (ungrounded.length) {
    return { decision: 'RE_GROUND', ok: false, reason: `ungrounded: ${ungrounded.join(', ')}`, ungrounded };
  }
  return { decision: 'OK', ok: true, reason: '', ungrounded: [] };
}

// ── T10 grounding probe (BRAIN-only, 0 LLM calls) ──────────────────────
// Cheap confidence probe adjacent to `isFinishAdmissible`: fraction of the
// summary's data tokens (numbers + entities, same extractors as the T2 gate)
// grounded in `observed`, rounded to 2 decimals. Empty summary → 0; a summary
// with no data tokens → 0 (fail-closed, never skip on vacuous confidence).
// Pure: no imports, no I/O, no LLM calls. Callers compare against PROBE_*
// thresholds in budget.ts.

/** Grounded fraction of a summary in 0..1 (2-decimal). */
export function groundingProbeConfidence(summary: string, observed: string): number {
  const s = summary ?? '';
  const o = observed ?? '';
  if (!s.trim()) return 0;
  const numToks = [...new Set(extractMatches(GATE_NUM_RE, s))];
  const capToks = extractEntityTokens(s);
  const total = numToks.length + capToks.length;
  if (total === 0) return 0;
  const obsNumToks = extractMatches(GATE_NUM_RE, o);
  let grounded = 0;
  for (const t of numToks) if (isNumberGrounded(t, o, obsNumToks)) grounded += 1;
  for (const t of capToks) if (isEntityGrounded(t, o)) grounded += 1;
  return Math.round((grounded / total) * 100) / 100;
}
