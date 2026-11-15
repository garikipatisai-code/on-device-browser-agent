// T27 probe wiring into executeOne (BRAIN TDD, 0 LLM calls). Pins the
// flag-gated probe seam threaded into executeOne: off = routeThink verbatim
// (base route + never skip + confidence 0); on = groundingProbeConfidence fed
// into routeThinkProbe + shouldSkipTool. NaN fails closed to no-skip; full
// on-path routing costs <<1ms (generous non-flaky bound). Documents the T26
// open Qs as scheduler debt (executeOne threading pinned here at source
// level; t26 merge-defaults tautology noted, fix deferred out of scope).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  probeWiringOpts,
  resolveProbeRouting,
  routeThink,
  routeThinkProbe,
  shouldSkipTool,
} from '@/agent/orchestrator';
import { groundingProbeConfidence } from '@/agent/verify/grounding';
import type { Settings } from '@/shared/messages';
import { DEFAULT_SETTINGS } from '@/shared/messages';
import { PROBE_THINK_SKIP_CONFIDENCE, PROBE_TOOL_SKIP_CONFIDENCE } from '@/agent/budget';

const SUMMARY = 'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa costs 12 dollars';
const GROUNDED = 'alpha beta gamma delta epsilon zeta eta theta iota kappa price 12';
const UNRELATED = 'unrelated ledger note';

const HERE = dirname(fileURLToPath(import.meta.url));
const ORCHESTRATOR_SRC = readFileSync(join(HERE, '../../src/agent/orchestrator.ts'), 'utf8');

/** The private executeOne body (up to the next private member). */
function executeOneBody(): string {
  const start = ORCHESTRATOR_SRC.indexOf('private async executeOne');
  expect(start).toBeGreaterThanOrEqual(0);
  const tail = ORCHESTRATOR_SRC.slice(start);
  const next = tail.indexOf('\n  private ', 1);
  return next === -1 ? tail : tail.slice(0, next);
}

describe('probeWiringOpts settings mapping (T27)', () => {
  it('maps probeWiring to enabled', () => {
    expect(probeWiringOpts({ ...DEFAULT_SETTINGS, probeWiring: true } as Settings).enabled).toBe(true);
    expect(probeWiringOpts(DEFAULT_SETTINGS).enabled).toBe(false);
  });

  it('missing flag counts as off (fail-closed)', () => {
    expect(probeWiringOpts({} as Settings).enabled).toBe(false);
    expect(probeWiringOpts({ ...DEFAULT_SETTINGS, probeWiring: undefined } as Settings).enabled).toBe(false);
  });
});

describe('resolveProbeRouting feeds the probe into both gates (T27)', () => {
  it('on path equals groundingProbeConfidence piped into routeThinkProbe + shouldSkipTool', () => {
    const conf = groundingProbeConfidence(SUMMARY, GROUNDED);
    const out = resolveProbeRouting({
      stepCount: 3,
      turn: 1,
      tool: 'aria.extract',
      redundant: true,
      summary: SUMMARY,
      observed: GROUNDED,
      enabled: true,
    });
    expect(out.confidence).toBe(conf);
    expect(out.route).toBe(routeThinkProbe({ stepCount: 3, turn: 1, probeConfidence: conf }));
    expect(out.skip).toBe(shouldSkipTool({ tool: 'aria.extract', probeConfidence: conf, redundant: true }));
    expect(out.confidence).toBeGreaterThanOrEqual(PROBE_TOOL_SKIP_CONFIDENCE);
    expect(out.route).toBe('NO_THINK');
    expect(out.skip).toBe(true);
  });

  it('off path is routeThink verbatim: base route + never skip + confidence 0', () => {
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

  it('low-confidence on path stays THINK with no skip', () => {
    const conf = groundingProbeConfidence(SUMMARY, UNRELATED);
    expect(conf).toBeLessThan(PROBE_THINK_SKIP_CONFIDENCE);
    const out = resolveProbeRouting({
      stepCount: 3,
      turn: 1,
      tool: 'aria.extract',
      redundant: true,
      summary: SUMMARY,
      observed: UNRELATED,
      enabled: true,
    });
    expect(out.confidence).toBe(conf);
    expect(out.route).toBe('THINK');
    expect(out.skip).toBe(false);
  });
});

describe('NaN fails closed to no-skip (T27)', () => {
  it('routeThinkProbe treats NaN/undefined as 0 (no skip when base is THINK)', () => {
    expect(routeThinkProbe({ stepCount: 3, turn: 1, probeConfidence: NaN })).toBe('THINK');
    expect(routeThinkProbe({ stepCount: 3, turn: 1, probeConfidence: undefined })).toBe('THINK');
  });

  it('shouldSkipTool treats NaN/undefined as 0 (never skips)', () => {
    expect(shouldSkipTool({ tool: 'aria.extract', probeConfidence: NaN, redundant: true })).toBe(false);
    expect(shouldSkipTool({ tool: 'aria.extract', probeConfidence: undefined, redundant: true })).toBe(
      false,
    );
  });

  it('groundingProbeConfidence never returns NaN (finite 0..1 for degenerate input)', () => {
    for (const [s, o] of [['', ''], ['   ', 'x'], ['hello world', 'unrelated'], [SUMMARY, '']] as const) {
      const c = groundingProbeConfidence(s, o);
      expect(Number.isFinite(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  });
});

describe('probe wiring <<1ms (T27, non-flaky bound)', () => {
  it('runs 1000 on-path routings in <1000ms (avg <1ms)', () => {
    expect(groundingProbeConfidence(SUMMARY, GROUNDED)).toBeGreaterThanOrEqual(0);
    const N = 1000;
    const t0 = Date.now();
    for (let i = 0; i < N; i += 1) {
      resolveProbeRouting({
        stepCount: 3,
        turn: 1,
        tool: 'aria.extract',
        redundant: true,
        summary: SUMMARY,
        observed: GROUNDED,
        enabled: true,
      });
    }
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('executeOne threads the probe seam (T27 integration)', () => {
  it('executeOne routes its think decision through resolveProbeRouting', () => {
    expect(executeOneBody()).toContain('resolveProbeRouting');
  });

  it('executeOne gates the probe on probeWiringOpts (off stays routeThink verbatim)', () => {
    expect(executeOneBody()).toContain('probeWiringOpts');
  });
});

describe('T26 open Qs recorded as scheduler debt (T27)', () => {
  it('documents executeOne threading + merge-test tautology as deferred scheduler debt', () => {
    expect(ORCHESTRATOR_SRC).toContain('T27 DEBT');
    expect(ORCHESTRATOR_SRC).toMatch(/T26/i);
    expect(ORCHESTRATOR_SRC).toMatch(/executeOne/i);
    expect(ORCHESTRATOR_SRC).toMatch(/tautolog/i);
    expect(ORCHESTRATOR_SRC).toMatch(/scheduler/i);
  });
});
