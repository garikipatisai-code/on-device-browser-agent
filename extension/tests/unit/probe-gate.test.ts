// T7: probe-gated think+tool skip (BRAIN TDD). Pure + deterministic, 0 LLM calls.
import { describe, expect, it } from 'vitest';
import { routeThinkProbe, shouldSkipTool } from '@/agent/orchestrator';
import { PROBE_THINK_SKIP_CONFIDENCE, PROBE_TOOL_SKIP_CONFIDENCE } from '@/agent/budget';

const LOW = 0.0;
const HIGH = 1.0;

describe('probe thresholds (budget.ts exported consts)', () => {
  it('are numbers in (0, 1)', () => {
    expect(PROBE_THINK_SKIP_CONFIDENCE).toBeGreaterThan(0);
    expect(PROBE_THINK_SKIP_CONFIDENCE).toBeLessThan(1);
    expect(PROBE_TOOL_SKIP_CONFIDENCE).toBeGreaterThan(0);
    expect(PROBE_TOOL_SKIP_CONFIDENCE).toBeLessThan(1);
  });
});

describe('routeThinkProbe — THINK/NO_THINK over routeThink', () => {
  it('keeps a single-tool base NO_THINK on NO_THINK', () => {
    expect(routeThinkProbe({ stepCount: 1, turn: 1, probeConfidence: LOW })).toBe('NO_THINK');
  });

  it('keeps a multi-step low-confidence probe on THINK', () => {
    expect(routeThinkProbe({ stepCount: 3, turn: 1, probeConfidence: LOW })).toBe('THINK');
  });

  it('skips a multi-step high-confidence probe to NO_THINK', () => {
    expect(routeThinkProbe({ stepCount: 3, turn: 1, probeConfidence: HIGH })).toBe('NO_THINK');
  });

  it('keeps every-3rd turn on THINK when probe confidence is low', () => {
    expect(routeThinkProbe({ stepCount: 1, turn: 3, probeConfidence: LOW })).toBe('THINK');
  });

  it('skips every-3rd turn to NO_THINK when probe confidence is high', () => {
    expect(routeThinkProbe({ stepCount: 1, turn: 3, probeConfidence: HIGH })).toBe('NO_THINK');
  });

  it('gates exactly at the exported think threshold', () => {
    expect(
      routeThinkProbe({ stepCount: 3, turn: 1, probeConfidence: PROBE_THINK_SKIP_CONFIDENCE }),
    ).toBe('NO_THINK');
    expect(
      routeThinkProbe({
        stepCount: 3,
        turn: 1,
        probeConfidence: PROBE_THINK_SKIP_CONFIDENCE - 0.01,
      }),
    ).toBe('THINK');
  });

  it('pins NaN/undefined to THINK when base is THINK', () => {
    expect(routeThinkProbe({ stepCount: 3, turn: 1, probeConfidence: NaN })).toBe('THINK');
    expect(routeThinkProbe({ stepCount: 3, turn: 1, probeConfidence: undefined })).toBe('THINK');
    expect(routeThinkProbe({ stepCount: 3, turn: 1 })).toBe('THINK');
  });
});

describe('shouldSkipTool — redundant observe only, never navigating/acting', () => {
  it('skips a redundant observe with high probe confidence', () => {
    expect(shouldSkipTool({ tool: 'aria.extract', probeConfidence: HIGH, redundant: true })).toBe(true);
    expect(shouldSkipTool({ tool: 'vision.read', probeConfidence: HIGH, redundant: true })).toBe(true);
  });

  it('does not skip an observe with low probe confidence', () => {
    expect(shouldSkipTool({ tool: 'aria.extract', probeConfidence: LOW, redundant: true })).toBe(false);
  });

  it('does not skip a non-redundant observe even with high confidence', () => {
    expect(shouldSkipTool({ tool: 'aria.extract', probeConfidence: HIGH, redundant: false })).toBe(false);
  });

  it('never skips navigating/acting tools even when redundant with high confidence', () => {
    for (const tool of ['tab.click', 'tab.open', 'open_result', 'tab.type', 'finish']) {
      expect(shouldSkipTool({ tool, probeConfidence: HIGH, redundant: true })).toBe(false);
    }
  });

  it('gates exactly at the exported tool threshold', () => {
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

  it('pins NaN/undefined to false', () => {
    expect(shouldSkipTool({ tool: 'aria.extract', probeConfidence: NaN, redundant: true })).toBe(false);
    expect(shouldSkipTool({ tool: 'aria.extract', probeConfidence: undefined, redundant: true })).toBe(
      false,
    );
  });
});
