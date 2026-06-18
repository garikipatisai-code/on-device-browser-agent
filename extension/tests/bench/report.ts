// Pure aggregation + formatting of benchmark results. No I/O.

import type { Score } from './scorer';

export interface TaskResult {
  id: string;
  scores: Score[];
  turns: number[];
}

export interface Aggregate {
  total: number;
  completed: number;
  correct: number;
  grounded: number;
  meanTurns: number;
}

export function aggregate(results: TaskResult[]): Aggregate {
  let total = 0, completed = 0, correct = 0, grounded = 0, turnSum = 0, turnN = 0;
  for (const t of results) {
    for (const s of t.scores) {
      total++;
      if (s.completed) completed++;
      if (s.correct) correct++;
      if (s.grounded) grounded++;
    }
    for (const n of t.turns) { turnSum += n; turnN++; }
  }
  return { total, completed, correct, grounded, meanTurns: turnN ? turnSum / turnN : 0 };
}

function pct(n: number, d: number): string {
  return `${d ? Math.round((n / d) * 100) : 0}%`.padStart(4);
}

export function formatReport(results: TaskResult[], opts: { model: string; trials: number }): string {
  const lines: string[] = [];
  lines.push(`\nTask-success benchmark — model=${opts.model}, trials/task=${opts.trials}\n`);
  for (const t of results) {
    const n = t.scores.length;
    const c = t.scores.filter((s) => s.completed).length;
    const ok = t.scores.filter((s) => s.correct).length;
    const g = t.scores.filter((s) => s.grounded).length;
    lines.push(
      `  ${t.id.padEnd(14)} completed ${pct(c, n)}  correct ${pct(ok, n)}  grounded ${pct(g, n)}`,
    );
    // Surface the first failure reason per task to make regressions debuggable.
    const firstBad = t.scores.find((s) => !s.correct || !s.grounded || !s.completed);
    if (firstBad && firstBad.reasons.length) lines.push(`                 ↳ ${firstBad.reasons[0]}`);
  }
  const a = aggregate(results);
  lines.push(`\n  ── totals over ${a.total} runs ──`);
  lines.push(`  completed ${pct(a.completed, a.total)}   correct ${pct(a.correct, a.total)}   grounded ${pct(a.grounded, a.total)}`);
  lines.push(`  mean turns ${a.meanTurns.toFixed(1)}`);
  lines.push(`  (grounded = no hallucinated numbers in the answer — the headline accuracy signal)\n`);
  return lines.join('\n');
}
