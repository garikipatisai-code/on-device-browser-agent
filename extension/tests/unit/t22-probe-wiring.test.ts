// T22 probe wiring <<1ms (BRAIN TDD, 0 LLM calls). Pins the flag-gated
// probe seam: off = legacy verbatim (byte-identical), on = confidence-gated
// skip; missing/low confidence never skips; probe cost <<1ms on a fixed
// fixture via a generous perf bound (avg <1ms, 200x headroom — trips only on
// pathological cost, never on CI jitter). Documents the T21 open Q
// (empty-steps warn vs silent) as scheduler-owned debt.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveProbeRouting, routeThink } from '@/agent/orchestrator';
import { groundingProbeConfidence } from '@/agent/verify/grounding';
import { PROBE_THINK_SKIP_CONFIDENCE, PROBE_TOOL_SKIP_CONFIDENCE } from '@/agent/budget';

const SUMMARY = 'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa costs 12 dollars';
const GROUNDED = 'alpha beta gamma delta epsilon zeta eta theta iota kappa price 12';
const UNRELATED = 'unrelated ledger note';

describe('T22 confidence-gated skip (flag-gated wiring)', () => {
  it('on + fully grounded confidence skips think and redundant observe', () => {
    const out = resolveProbeRouting({
      stepCount: 3,
      turn: 1,
      tool: 'aria.extract',
      redundant: true,
      summary: SUMMARY,
      observed: GROUNDED,
      enabled: true,
    });
    expect(out.confidence).toBe(groundingProbeConfidence(SUMMARY, GROUNDED));
    expect(out.confidence).toBeGreaterThanOrEqual(PROBE_TOOL_SKIP_CONFIDENCE);
    expect(out.confidence).toBeGreaterThanOrEqual(PROBE_THINK_SKIP_CONFIDENCE);
    expect(out.route).toBe('NO_THINK');
    expect(out.skip).toBe(true);
  });

  it('off path is legacy verbatim: base routeThink + never skip + confidence 0', () => {
    for (const enabled of [undefined, false] as const) {
      const out = resolveProbeRouting({
        stepCount: 3,
        turn: 1,
        tool: 'aria.extract',
        redundant: true,
        summary: SUMMARY,
        observed: GROUNDED,
        enabled,
      });
      expect(out.route).toBe(routeThink({ stepCount: 3, turn: 1 }));
      expect(out.route).toBe('THINK');
      expect(out.skip).toBe(false);
      expect(out.confidence).toBe(0);
    }
  });
});

describe('T22 missing/low confidence never skips', () => {
  it('empty summary on path stays THINK with no skip', () => {
    const out = resolveProbeRouting({
      stepCount: 3,
      turn: 1,
      tool: 'aria.extract',
      redundant: true,
      summary: '',
      observed: GROUNDED,
      enabled: true,
    });
    expect(out.confidence).toBe(0);
    expect(out.route).toBe('THINK');
    expect(out.skip).toBe(false);
  });

  it('no-data-token summary stays THINK with no skip (fail-closed, no vacuous skip)', () => {
    const summary = 'done and ok';
    expect(groundingProbeConfidence(summary, GROUNDED)).toBe(0);
    const out = resolveProbeRouting({
      stepCount: 3,
      turn: 1,
      tool: 'aria.extract',
      redundant: true,
      summary,
      observed: GROUNDED,
      enabled: true,
    });
    expect(out.confidence).toBe(0);
    expect(out.route).toBe('THINK');
    expect(out.skip).toBe(false);
  });

  it('low (unrelated observed) confidence stays THINK with no skip', () => {
    const out = resolveProbeRouting({
      stepCount: 3,
      turn: 1,
      tool: 'aria.extract',
      redundant: true,
      summary: SUMMARY,
      observed: UNRELATED,
      enabled: true,
    });
    expect(out.confidence).toBeLessThan(PROBE_THINK_SKIP_CONFIDENCE);
    expect(out.route).toBe('THINK');
    expect(out.skip).toBe(false);
  });

  it('never skips navigating/acting tools even at high confidence', () => {
    for (const tool of ['tab.click', 'tab.open', 'open_result', 'tab.type', 'finish']) {
      const out = resolveProbeRouting({
        stepCount: 3,
        turn: 1,
        tool,
        redundant: true,
        summary: SUMMARY,
        observed: GROUNDED,
        enabled: true,
      });
      expect(out.skip).toBe(false);
    }
  });
});

describe('T22 probe wiring <<1ms on fixture (perf assert, non-flaky bound)', () => {
  it('runs 1000 probes on a fixed fixture in <1000ms (avg <1ms)', () => {
    const summary = SUMMARY;
    const observed = GROUNDED;
    // Warm up once so JIT does not pollute the measurement.
    expect(groundingProbeConfidence(summary, observed)).toBeGreaterThanOrEqual(0);
    const N = 1000;
    const t0 = Date.now();
    for (let i = 0; i < N; i += 1) {
      resolveProbeRouting({
        stepCount: 3,
        turn: 1,
        tool: 'aria.extract',
        redundant: true,
        summary,
        observed,
        enabled: true,
      });
    }
    const elapsed = Date.now() - t0;
    // Generous: 1000 pure sync probes must finish in <1000ms (avg <1ms).
    // A real <<1ms probe lands in the low-ms total — this bound only trips
    // on a pathological (quadratic/regex-catastrophic/async-LLM) wiring,
    // never on CI jitter.
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('T21 open Q recorded as scheduler debt (T22)', () => {
  it('documents empty-steps warn vs silent as deferred scheduler debt', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const text = readFileSync(join(here, '../../src/agent/orchestrator.ts'), 'utf8');
    expect(text).toContain('T22 DEBT');
    expect(text).toMatch(/empty-steps/i);
    expect(text).toMatch(/warn vs silent/);
    expect(text).toMatch(/scheduler/i);
  });
});
