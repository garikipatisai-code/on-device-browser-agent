// Pure grounding helpers shared by the live finish-verifier and the benchmark scorer.
// "Grounded" = every number an answer asserts actually appeared in the text the agent
// read. Bare single digits ("1.", "top 3") are intentionally NOT treated as data, so
// list markers never look like hallucinations.

const NUM_RE = /\$\s?\d[\d,]*(?:\.\d+)?|\b\d+\.\d+\b|\b\d{2,}\b/g;

export function normNum(tok: string): string {
  return tok.replace(/[$\s,]/g, '');
}

export function dataNumbers(s: string): string[] {
  const m = s.match(NUM_RE);
  if (!m) return [];
  return [...new Set(m.map(normNum))];
}

/** Numbers in `text` that do NOT appear anywhere in `observed`. Matches whole
 *  normalized numbers (set membership), NOT raw substrings — so a claimed "4.6"
 *  is NOT considered grounded just because the page said "14.62". */
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
const MISSING_RE =
  /\bnot (listed|shown|available|provided|mentioned|specified|found|displayed|stated)(?!\s+(?:at|for)\b(?=[^.!?;]{0,60}(?:\$\s?\d|\bon sale\b)))\b|\b(could ?n'?t|can ?not|could not|unable to) (find|locate)\b|\bno mention\b|\bdo(es)?(?: ?n'?t| not) (list|mention|show|include|provide|state)\b|\bunavailable\b/i;

/** True if a finish summary claims a requested field is missing/absent. */
export function mentionsMissing(text: string): boolean {
  return MISSING_RE.test(text);
}
