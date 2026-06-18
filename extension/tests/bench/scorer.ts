// Pure, deterministic scorer for a single benchmark run. No model calls.

import type { Expectation } from './fixtures';

export interface BenchRun {
  phase: 'DONE' | 'ABORTED';
  verdict: string;        // finish verdict (success|partial|blocked|failed|aborted)
  summary: string;        // finish.summary — the user-facing answer
  observedText: string;   // all aria.extract + search outputs seen this run (+ profileJson)
  turns: number;
  replans: number;
}

export interface Score {
  completed: boolean;
  correct: boolean;
  grounded: boolean;
  reasons: string[];      // human-readable failure notes
}

// Currency, decimals (ratings/prices), or multi-digit integers (years, counts).
// Bare single digits (list markers "1.", "top 3") are intentionally NOT matched,
// so they never produce a false hallucination flag.
const NUM_RE = /\$\s?\d[\d,]*(?:\.\d+)?|\b\d+\.\d+\b|\b\d{2,}\b/g;

function normNum(tok: string): string {
  return tok.replace(/[$\s,]/g, '');
}

export function dataNumbers(s: string): string[] {
  const m = s.match(NUM_RE);
  if (!m) return [];
  return [...new Set(m.map(normNum))];
}

/** Numbers in `summary` that do NOT appear anywhere in `observed`. */
export function ungroundedNumbers(summary: string, observed: string): string[] {
  const obs = observed.replace(/[$\s,]/g, '');
  return dataNumbers(summary).filter((n) => !obs.includes(n));
}

function matches(summary: string, m: string | RegExp): boolean {
  return typeof m === 'string' ? summary.includes(m) : m.test(summary);
}

function inOrder(summary: string, items: string[]): boolean {
  let idx = 0;
  for (const it of items) {
    const at = summary.indexOf(it, idx);
    if (at < 0) return false;
    idx = at + it.length;
  }
  return true;
}

export function scoreRun(exp: Expectation, run: BenchRun): Score {
  const reasons: string[] = [];

  const completed = run.phase === 'DONE';
  if (!completed) reasons.push(`did not complete (phase=${run.phase}, verdict=${run.verdict})`);

  // correct
  let correct = true;
  if (!exp.verdict.includes(run.verdict)) {
    correct = false;
    reasons.push(`verdict ${run.verdict} not in [${exp.verdict.join(',')}]`);
  }
  for (const m of exp.mustContain ?? []) {
    if (!matches(run.summary, m)) {
      correct = false;
      reasons.push(`missing required: ${m.toString()}`);
    }
  }
  if (exp.orderedList && !inOrder(run.summary, exp.orderedList)) {
    correct = false;
    reasons.push(`not in order: [${exp.orderedList.join(', ')}]`);
  }

  // grounded
  let grounded = true;
  const ungrounded = ungroundedNumbers(run.summary, run.observedText);
  if (ungrounded.length) {
    grounded = false;
    reasons.push(`ungrounded numbers (hallucinated): ${ungrounded.join(', ')}`);
  }
  const obsLC = run.observedText.toLowerCase();
  const sumLC = run.summary.toLowerCase();
  for (const e of exp.entities ?? []) {
    const eLC = e.toLowerCase();
    if (sumLC.includes(eLC) && !obsLC.includes(eLC)) {
      grounded = false;
      reasons.push(`ungrounded entity: "${e}"`);
    }
  }
  // A forbidden pattern means the answer asserted a field the page never showed
  // (e.g. a CSS-only star rating). That is a fabrication — fail it on `grounded`,
  // since number-grounding alone can't catch single-digit values like "5 stars".
  for (const m of exp.mustNotContain ?? []) {
    if (matches(run.summary, m)) {
      grounded = false;
      reasons.push(`fabricated / not on page: ${m.toString()}`);
    }
  }

  return { completed, correct, grounded, reasons };
}
