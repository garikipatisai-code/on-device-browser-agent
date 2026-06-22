// A small, grounded, always-in-context ledger of the facts a run has established.
// Pure (no I/O) so it is trivially testable; the orchestrator owns the array + persistence.
import { ungroundedNumbers } from './verify/grounding';

export interface Fact {
  step: string;
  text: string;
  url?: string;
}

/** Append `candidate` iff its text is non-empty, FULLY grounded in `observed` (every number it
 *  asserts appears in what was read), and not already present. Returns a new bounded array
 *  (≤ max, oldest dropped). Never throws; purely additive. */
export function addGroundedFact(facts: Fact[], candidate: Fact, observed: string, max = 24): Fact[] {
  const text = candidate.text.trim();
  if (!text) return facts;
  if (ungroundedNumbers(text, observed).length) return facts;
  if (facts.some((f) => f.text === text)) return facts;
  const next = [...facts, { ...candidate, text }];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Render the ledger for the FINDINGS prompt slot. `undefined` when empty so the caller's
 *  `.filter(Boolean)` drops the section. Bounded to `maxChars` (keeps the most recent). */
export function renderFacts(facts: Fact[], maxChars = 4_000): string | undefined {
  if (!facts.length) return undefined;
  const block = facts.map((f) => `- ${f.text}${f.url ? ` [${f.url}]` : ''}`).join('\n');
  if (block.length <= maxChars) return block;
  // Tail-bound to the most recent, but snap to a line boundary so the top bullet isn't garbled.
  const cut = block.slice(block.length - maxChars);
  const nl = cut.indexOf('\n');
  return nl >= 0 ? cut.slice(nl + 1) : cut;
}

/** Grounding corpus = raw observed text PLUS the durable fact texts, so a fact whose source page
 *  has been evicted from the 60K observed-text FIFO still grounds the final answer. */
export function groundingCorpus(observed: string, facts: Fact[]): string {
  return [observed, ...facts.map((f) => f.text)].filter(Boolean).join('\n');
}
