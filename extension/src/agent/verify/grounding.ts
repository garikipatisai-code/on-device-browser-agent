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
