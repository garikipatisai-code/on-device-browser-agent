// T17 probe wiring (BRAIN TDD, 0 LLM calls). Pins the cheap grounding probe
// fraction, the exact probe-gate thresholds, NaN fail-closed, a non-flaky
// probe-cost bound, and the flag-gated wiring (off = legacy verbatim).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveProbeRouting, routeThink, routeThinkProbe, shouldSkipTool } from '@/agent/orchestrator';
import { groundingProbeConfidence } from '@/agent/verify/grounding';
import { PROBE_THINK_SKIP_CONFIDENCE, PROBE_TOOL_SKIP_CONFIDENCE } from '@/agent/budget';

describe('groundingProbeConfidence fraction (T17)', () => {
  it('returns a 0..1 fraction rounded to 2 decimals', () => {
    // 9/10 entities grounded.
    expect(
      groundingProbeConfidence(
        'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa',
        'alpha beta gamma delta epsilon zeta eta theta iota ledger note',
      ),
    ).toBe(0.9);
    // 5/7 entities grounded.
    expect(
      groundingProbeConfidence(
        'Alpha Bravo Charlie Delta Echo Foxtrot Golf',
        'alpha bravo charlie delta echo ledger note',
      ),
    ).toBe(0.71);
  });

  it('is empty-safe (empty summary -> 0) and vacuously confident with no data tokens', () => {
    expect(groundingProbeConfidence('', 'anything')).toBe(0);
    expect(groundingProbeConfidence('   ', 'anything')).toBe(0);
    expect(groundingProbeConfidence('hello world', 'unrelated text')).toBe(1);
  });

  it('grounds numbers the same way the T2 gate does', () => {
    expect(groundingProbeConfidence('Price 12', 'price 12 total')).toBe(1);
    expect(groundingProbeConfidence('Price 12', 'no figures here')).toBe(0);
  });
});

describe('probe thresholds exact (T17)', () => {
  it('routeThinkProbe gates exactly at PROBE_THINK_SKIP_CONFIDENCE', () => {
    expect(routeThinkProbe({ stepCount: 3, turn: 1, probeConfidence: PROBE_THINK_SKIP_CONFIDENCE })).toBe(
      'NO_THINK',
    );
    expect(
      routeThinkProbe({ stepCount: 3, turn: 1, probeConfidence: PROBE_THINK_SKIP_CONFIDENCE - 0.01 }),
    ).toBe('THINK');
  });

  it('shouldSkipTool gates exactly at PROBE_TOOL_SKIP_CONFIDENCE', () => {
    expect(
      shouldSkipTool({ tool: 'aria.extract', probeConfidence: PROBE_TOOL_SKIP_CONFIDENCE, redundant: true }),
    ).toBe(true);
    expect(
      shouldSkipTool({
        tool: 'aria.extract',
        probeConfidence: PROBE_TOOL_SKIP_CONFIDENCE - 0.01,
        redundant: true,
      }),
    ).toBe(false);
  });
});

describe('NaN fails closed to no-skip (T17)', () => {
  it('routeThinkProbe treats NaN/undefined/missing as 0 (no skip when base is THINK)', () => {
    expect(routeThinkProbe({ stepCount: 3, turn: 1, probeConfidence: NaN })).toBe('THINK');
    expect(routeThinkProbe({ stepCount: 3, turn: 1, probeConfidence: undefined })).toBe('THINK');
    expect(routeThinkProbe({ stepCount: 3, turn: 1 })).toBe('THINK');
  });

  it('shouldSkipTool treats NaN/undefined as 0 (never skips)', () => {
    expect(shouldSkipTool({ tool: 'aria.extract', probeConfidence: NaN, redundant: true })).toBe(false);
    expect(shouldSkipTool({ tool: 'aria.extract', probeConfidence: undefined, redundant: true })).toBe(
      false,
    );
  });
});

describe('probe cost <<1ms (T17, non-flaky bound)', () => {
  it('runs hundreds of probes well inside a generous wall-clock budget (avg <<1ms)', () => {
    const summary = 'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa costs 12 dollars';
    const observed = 'alpha beta gamma delta epsilon zeta eta theta iota kappa price 12 ledger note';
    // Warm up once so JIT does not pollute the measurement.
    expect(groundingProbeConfidence(summary, observed)).toBeGreaterThanOrEqual(0);
    const N = 300;
    const t0 = Date.now();
    for (let i = 0; i < N; i += 1) {
      groundingProbeConfidence(summary, observed);
    }
    const elapsed = Date.now() - t0;
    // Generous: 300 pure string probes must finish in <1000ms (avg <3.3ms).
    // A real <<1ms probe lands in the low single-digit ms total — this bound
    // only trips on a pathological (quadratic/regex-catastrophic) probe,
    // never on CI jitter.
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('resolveProbeRouting flag-gated wiring (T17)', () => {
  const grounded = 'alpha beta gamma delta epsilon zeta eta theta iota kappa price 12';
  const summary = 'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa costs 12 dollars';

  it('off path is legacy verbatim: base routeThink + never skip, even at high confidence', () => {
    for (const enabled of [undefined, false] as const) {
      const out = resolveProbeRouting({
        stepCount: 3,
        turn: 1,
        tool: 'aria.extract',
        redundant: true,
        summary,
        observed: grounded,
        enabled,
      });
      expect(out.route).toBe(routeThink({ stepCount: 3, turn: 1 }));
      expect(out.route).toBe('THINK');
      expect(out.skip).toBe(false);
      expect(out.confidence).toBe(0);
    }
  });

  it('on path wires the probe: high confidence skips think + redundant observe', () => {
    const out = resolveProbeRouting({
      stepCount: 3,
      turn: 1,
      tool: 'aria.extract',
      redundant: true,
      summary,
      observed: grounded,
      enabled: true,
    });
    expect(out.confidence).toBe(groundingProbeConfidence(summary, grounded));
    expect(out.confidence).toBeGreaterThanOrEqual(PROBE_THINK_SKIP_CONFIDENCE);
    expect(out.route).toBe('NO_THINK');
    expect(out.skip).toBe(true);
  });

  it('on path keeps low confidence on THINK without tool skip', () => {
    const out = resolveProbeRouting({
      stepCount: 3,
      turn: 1,
      tool: 'aria.extract',
      redundant: true,
      summary,
      observed: 'unrelated ledger note',
      enabled: true,
    });
    expect(out.confidence).toBeLessThan(PROBE_THINK_SKIP_CONFIDENCE);
    expect(out.route).toBe('THINK');
    expect(out.skip).toBe(false);
  });

  it('on path never skips navigating/acting tools even at high confidence', () => {
    for (const tool of ['tab.click', 'tab.open', 'open_result', 'tab.type', 'finish']) {
      const out = resolveProbeRouting({
        stepCount: 3,
        turn: 1,
        tool,
        redundant: true,
        summary,
        observed: grounded,
        enabled: true,
      });
      expect(out.skip).toBe(false);
    }
  });
});

describe('T16 open questions recorded as scheduler debt (T17)', () => {
  it('documents empty-steps warn + retry idempotence as deferred scheduler debt', () => {
    const text = readFileSync(join(process.cwd(), 'src/agent/orchestrator.ts'), 'utf8');
    expect(text).toContain('T16 DEBT');
    expect(text).toMatch(/empty-steps/i);
    expect(text).toMatch(/idempotence/);
    expect(text).toMatch(/scheduler/i);
  });
});
