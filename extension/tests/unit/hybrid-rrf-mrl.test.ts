import { describe, expect, it } from 'vitest';
import {
  CASCADE_SCORE_CUTOFF,
  HybridRetriever,
  MRL_PREFIX_BYTES,
  RRF_K,
  cascadeCutoff,
  hammingDistance,
  hammingDistance256,
} from '@/agent/workflow_memory';
import { anchoredCompact } from '@/agent/orchestrator';
import { groundingProbeConfidence } from '@/agent/verify/grounding';
import { PROBE_THINK_SKIP_CONFIDENCE, PROBE_TOOL_SKIP_CONFIDENCE } from '@/agent/budget';

function vec64(fill: number): Uint8Array {
  return new Uint8Array(64).fill(fill);
}

describe('T10 RRF-60 fusion (BRAIN TDD)', () => {
  it('pins RRF K=60', () => {
    expect(RRF_K).toBe(60);
  });

  it('fuses keyword + vector ranks with 1/(K+rank+1)', () => {
    const r = new HybridRetriever();
    const qv = vec64(0x00);
    r.index('anchor-a', 'compare populations of cities', vec64(0x00));
    r.index('anchor-b', 'translate this page to spanish', vec64(0xff));
    const c = vec64(0x00);
    c[0] = 0xff;
    r.index('anchor-c', 'compare populations of cities translate page', c);
    const hits = r.query({ text: 'compare populations', vec512: qv, topK: 3 });
    expect(hits[0].anchor).toBe('anchor-a');
    for (const h of hits) expect(h.mode).toBe('RRF');
    // anchor-a is rank 0 in both lists -> 1/(60+0+1) + 1/(60+0+1) = 2/61
    expect(hits[0].score).toBeCloseTo(2 / 61, 10);
  });
});

describe('T10 MRL-256 Hamming + rescore order (BRAIN TDD)', () => {
  it('exposes a 32-byte MRL-256 prefix', () => {
    expect(MRL_PREFIX_BYTES).toBe(32);
  });

  it('prefix Hamming sees only the first 256 bits', () => {
    const q = vec64(0x00);
    const a = vec64(0x00);
    a.fill(0xff, 32, 64); // prefix clean, suffix fully flipped
    const b = vec64(0x00);
    b[0] = 0xff; // prefix 8 bits flipped, suffix clean
    expect(hammingDistance256(q, a)).toBe(0);
    expect(hammingDistance256(q, b)).toBe(8);
    expect(hammingDistance(q, a)).toBe(256);
    expect(hammingDistance(q, b)).toBe(8);
  });

  it('full-vector rescore wins over prefix order on keyword tie', () => {
    const r = new HybridRetriever();
    const q = vec64(0x00);
    const aVec = vec64(0x00);
    aVec.fill(0xff, 32, 64);
    const bVec = vec64(0x00);
    bVec[0] = 0xff;
    // Identical summaries -> keyword ranks tie, vector decides.
    r.index('anchor-prefix-best', 'river populations handbook', aVec);
    r.index('anchor-full-best', 'river populations handbook', bVec);
    const hits = r.query({ text: 'river populations handbook', vec512: q, topK: 2 });
    // Prefix alone would rank anchor-prefix-best first (0 < 8);
    // full Hamming rescore must put anchor-full-best first (8 < 256).
    expect(hits[0].anchor).toBe('anchor-full-best');
  });
});

describe('T10 cascade cutoff (BRAIN TDD, stub no model)', () => {
  it('exports a numeric cascade score cutoff', () => {
    expect(typeof CASCADE_SCORE_CUTOFF).toBe('number');
  });

  it('drops low-score tail, keeps order', () => {
    const hits = [
      { anchor: 'a', summary: 'sa', score: 0.9, mode: 'RRF' as const },
      { anchor: 'b', summary: 'sb', score: 0.5, mode: 'RRF' as const },
      { anchor: 'c', summary: 'sc', score: 0.1, mode: 'RRF' as const },
    ];
    const kept = cascadeCutoff(hits, 0.2);
    expect(kept.map((h) => h.anchor)).toEqual(['a', 'b']);
  });

  it('queryCascade applies the cutoff without any model call', () => {
    const r = new HybridRetriever();
    r.index('anchor-a', 'compare populations of cities', vec64(0x00));
    r.index('anchor-b', 'translate this page to spanish', vec64(0xff));
    const hits = r.queryCascade({ text: 'compare populations', vec512: vec64(0x00), topK: 5 }, 5, 100);
    expect(hits).toEqual([]);
  });
});

describe('T10 anchored compact (BRAIN TDD)', () => {
  it('preserves goal+facts+anchor, keeps scratch prefix, respects budget', () => {
    const goal = 'GOAL-compare-populations';
    const facts = 'FACTS-austin-1M';
    const anchor = 'ANCHOR-same-site-source';
    const scratch = `x-${'s'.repeat(5000)}-tail-should-truncate`;
    const out = anchoredCompact({ goal, facts, anchor, scratch, maxChars: 1000 });
    expect(out).toContain(goal);
    expect(out).toContain(facts);
    expect(out).toContain(anchor);
    // compact keeps the scratch PREFIX (head), not the tail
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out.indexOf(goal)).toBeLessThan(out.indexOf('x-'));
  });
});

describe('T10 grounding probes adjacent to isFinishAdmissible (BRAIN TDD, 0 LLM)', () => {
  it('0.90 fixture: 9/10 entities grounded', () => {
    const summary = 'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa';
    const observed = 'alpha beta gamma delta epsilon zeta eta theta iota ledger note';
    expect(groundingProbeConfidence(summary, observed)).toBe(0.9);
  });

  it('0.71 fixture: 5/7 entities grounded', () => {
    const summary = 'Alpha Bravo Charlie Delta Echo Foxtrot Golf';
    const observed = 'alpha bravo charlie delta echo ledger note';
    expect(groundingProbeConfidence(summary, observed)).toBe(0.71);
  });

  it('0.90 clears think+tool gates, 0.71 clears neither', () => {
    expect(0.9).toBeGreaterThanOrEqual(PROBE_THINK_SKIP_CONFIDENCE);
    expect(0.9).toBeGreaterThanOrEqual(PROBE_TOOL_SKIP_CONFIDENCE);
    expect(0.71).toBeLessThan(PROBE_THINK_SKIP_CONFIDENCE);
    expect(0.71).toBeLessThan(PROBE_TOOL_SKIP_CONFIDENCE);
  });
});
