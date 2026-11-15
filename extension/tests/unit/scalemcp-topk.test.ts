import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOPK,
  FLAT_FALLBACK,
  HybridRetriever,
  RRF_K,
  matchWorkflow,
  matchWorkflows,
  normalizeTopK,
  renderRecipe,
  renderTopRecipes,
  type Workflow,
} from '@/agent/workflow_memory';

function wf(id: string): Workflow {
  return {
    id,
    origin: 'builtin',
    domain: '*',
    goalKeywords: ['compare', 'price'],
    requiredAny: ['compare'],
    goalSample: 'compare price sample',
    steps: [{ instruction: `Step for ${id}` }],
  };
}

function vec(fill: number): Uint8Array {
  return new Uint8Array(64).fill(fill);
}

function seed7(r: HybridRetriever): void {
  for (let i = 0; i < 7; i++) {
    r.index(`anchor-${i}`, `handbook overview entry number ${i} river populations`, vec(i));
  }
}

describe('T11 ScaleMCP top-k (BRAIN TDD)', () => {
  it('clamps bad topK to default 5', () => {
    expect(normalizeTopK(undefined)).toBe(5);
    expect(normalizeTopK(0)).toBe(5);
    expect(normalizeTopK(-3)).toBe(5);
    expect(normalizeTopK(NaN)).toBe(5);
    expect(normalizeTopK(2)).toBe(2);
  });

  it('bounds query results to topK', () => {
    const r = new HybridRetriever();
    seed7(r);
    const hits = r.query({ text: 'river populations handbook', vec512: vec(0), topK: 2 });
    expect(hits.length).toBeLessThanOrEqual(2);
    expect(hits.length).toBe(2);
  });

  it('defaults bad topK to 5 instead of empty/unbounded', () => {
    const r = new HybridRetriever();
    seed7(r);
    for (const bad of [0, -1, NaN]) {
      const hits = r.query({ text: 'river populations handbook', vec512: vec(0), topK: bad });
      expect(hits.length).toBe(5);
    }
  });

  it('dedupes parents before slicing the bound', () => {
    const r = new HybridRetriever();
    r.index('parent-a', 'compare populations of cities anchor source', vec(0x00));
    r.indexChild('parent-a', 'parent-a#c1', 'compare populations austin city proper', vec(0x00));
    r.indexChild('parent-a', 'parent-a#c2', 'compare populations austin city proper', vec(0x00));
    r.index('parent-b', 'translate this page to spanish', vec(0xff));
    const hits = r.query({ text: 'austin city proper populations', topK: 5 });
    expect(hits.map((h) => h.anchor)).toContain('parent-a');
    expect(hits.filter((h) => h.anchor === 'parent-a')).toHaveLength(1);
    const one = r.query({ text: 'austin city proper populations', topK: 1 });
    expect(one).toHaveLength(1);
    expect(one[0].anchor).toBe('parent-a');
  });

  it('queryTopK delegates with the same bound + parent dedupe', () => {
    const r = new HybridRetriever();
    seed7(r);
    const hits = r.queryTopK({ text: 'river populations handbook', vec512: vec(0) }, 2);
    expect(hits.length).toBe(2);
    const bad = r.queryTopK({ text: 'river populations handbook', vec512: vec(0) }, NaN);
    expect(bad.length).toBe(5);
  });

  it('empty index returns empty', () => {
    const r = new HybridRetriever();
    expect(r.query({ text: 'anything', topK: 5 })).toEqual([]);
    expect(r.queryTopK({ text: 'anything' }, 2)).toEqual([]);
  });

  it('preserves RRF-60 fusion and FLAT fallback', () => {
    expect(RRF_K).toBe(60);
    const r = new HybridRetriever();
    r.index('anchor-a', 'compare populations of cities', vec(0x00));
    r.index('anchor-b', 'translate this page to spanish', vec(0xff));
    const fused = r.query({ text: 'compare populations', vec512: vec(0x00), topK: 2 });
    for (const h of fused) expect(h.mode).toBe('RRF');
    expect(fused[0].anchor).toBe('anchor-a');
    const flat = r.query({ text: 'translate spanish page', topK: 2 });
    for (const h of flat) expect(h.mode).toBe(FLAT_FALLBACK);
    expect(flat[0].anchor).toBe('anchor-b');
  });
});

describe('T12 cascade prefilter bound (BRAIN TDD)', () => {
  it('clamps bad prefilterTopK same as normalizeTopK', () => {
    const r = new HybridRetriever();
    seed7(r);
    const q = { text: 'river populations handbook', vec512: vec(0), topK: 7 };
    const expected = r.queryCascade(q, 5);
    expect(expected.length).toBe(5);
    for (const bad of [0, -1, NaN, Infinity]) {
      const hits = r.queryCascade(q, bad);
      expect(hits.map((h) => h.anchor)).toEqual(expected.map((h) => h.anchor));
    }
  });

  it('preserves cutoff order', () => {
    const r = new HybridRetriever();
    seed7(r);
    const q = { text: 'river populations handbook', vec512: vec(0), topK: 7 };
    const full = r.queryCascade(q, 5, Number.NEGATIVE_INFINITY);
    const cut = r.queryCascade(q, 5, 0.032);
    expect(cut.length).toBeGreaterThan(0);
    expect(cut.length).toBeLessThan(full.length);
    const fullOrder = full.map((h) => h.anchor);
    const cutOrder = cut.map((h) => h.anchor);
    let j = 0;
    for (const a of cutOrder) {
      const k = fullOrder.indexOf(a, j);
      expect(k).toBeGreaterThanOrEqual(j);
      j = k + 1;
    }
  });
});

describe('T14 top-k caller wiring (BRAIN TDD)', () => {
  it('[0] equals the sequential single match on full ties', () => {
    const wfs = [wf('t14-a'), wf('t14-b'), wf('t14-c')];
    const goal = 'compare price';
    const single = matchWorkflow(goal, wfs);
    const top = matchWorkflows(goal, wfs, 3);
    expect(single?.id).toBe('t14-a');
    expect(top.map((w) => w.id)).toEqual(['t14-a', 't14-b', 't14-c']);
    expect(top[0]?.id).toBe(single?.id);
  });

  it('omitting topK is identical to DEFAULT_TOPK', () => {
    const wfs = Array.from({ length: 7 }, (_, i) => wf(`t14-${i}`));
    const goal = 'compare price';
    expect(matchWorkflows(goal, wfs).map((w) => w.id)).toEqual(
      matchWorkflows(goal, wfs, DEFAULT_TOPK).map((w) => w.id),
    );
    expect(renderTopRecipes(goal, wfs)).toBe(renderTopRecipes(goal, wfs, DEFAULT_TOPK));
  });

  it('bounds the set and clamps bad topK, undefined on no match', () => {
    const wfs = Array.from({ length: 7 }, (_, i) => wf(`t14-${i}`));
    const goal = 'compare price';
    expect(matchWorkflows(goal, wfs, 2).map((w) => w.id)).toEqual(['t14-0', 't14-1']);
    for (const bad of [0, -1, NaN]) {
      expect(matchWorkflows(goal, wfs, bad)).toHaveLength(DEFAULT_TOPK);
    }
    const rendered = renderTopRecipes(goal, wfs, 2);
    expect(rendered?.split('\n---\n')).toHaveLength(2);
    expect(rendered?.split('\n---\n')[0]).toBe(renderRecipe(wfs[0]));
    expect(renderTopRecipes('xyzzy qqqqq zzzzzz', wfs, 2)).toBeUndefined();
  });
});
