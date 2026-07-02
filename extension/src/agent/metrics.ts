// Per-op latency telemetry. In-memory aggregator + optional IDB sink.
import { recordMetric } from '@/background/state_store';
import type { MetricsSnapshot } from '@/shared/messages';

interface OpStats {
  n: number;
  ok: number;
  samples: number[];
}

const MAX_SAMPLES = 200;

const ops = new Map<string, OpStats>();

function record(op: string, ms: number, ok: boolean): void {
  let s = ops.get(op);
  if (!s) {
    s = { n: 0, ok: 0, samples: [] };
    ops.set(op, s);
  }
  s.n += 1;
  if (ok) s.ok += 1;
  s.samples.push(ms);
  if (s.samples.length > MAX_SAMPLES) s.samples.shift();
}

export async function timed<T>(
  op: string,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = performance.now();
  let ok = false;
  try {
    const r = await fn();
    ok = true;
    return r;
  } finally {
    const ms = performance.now() - t0;
    record(op, ms, ok);
    void recordMetric({ ts: Date.now(), op, ms, ok });
  }
}

export function metricsSnapshot(): MetricsSnapshot {
  const out: MetricsSnapshot['ops'] = [];
  for (const [op, s] of ops.entries()) {
    const sorted = [...s.samples].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
    const mean = s.samples.reduce((a, b) => a + b, 0) / Math.max(1, s.samples.length);
    out.push({ op, n: s.n, ok: s.ok, p50, mean });
  }
  out.sort((a, b) => a.op.localeCompare(b.op));
  return { ops: out };
}

export function resetMetrics(): void {
  ops.clear();
}
