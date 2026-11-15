// T19 retriever threading + UD-Q4_K_XL / n-gram / cache bench (BRAIN TDD, 0 LLM calls).
// Pins: normalizeTopK clamp, dedup-before-slice length≤topK, RRF-60 + FLAT
// preserved, cascade order, and the UD/bench-harness pure-config seam
// (cache_prompt pinned, no speculative keys, llama-only docs).
// Pure stubs only: no OllamaClient instantiation, no fetch, no model calls.
import { describe, expect, it } from 'vitest';
import {
  CASCADE_SCORE_CUTOFF,
  DEFAULT_TOPK,
  FLAT_FALLBACK,
  HybridRetriever,
  RRF_K,
  normalizeTopK,
  retrieveThreaded,
} from '@/agent/workflow_memory';
import { buildOllamaOptions } from '@/background/ollama';

function vec(fill: number): Uint8Array {
  return new Uint8Array(64).fill(fill);
}

function seed7(r: HybridRetriever): void {
  for (let i = 0; i < 7; i++) {
    r.index(`anchor-${i}`, `handbook overview entry number ${i} river populations`, vec(i));
  }
}

/** One parent with two child chunks + one unrelated parent (dedupe fixture). */
function seedParentChild(r: HybridRetriever): void {
  r.index('parent-a', 'compare populations of cities anchor source', vec(0x00));
  r.indexChild('parent-a', 'parent-a#c1', 'compare populations austin city proper', vec(0x00));
  r.indexChild('parent-a', 'parent-a#c2', 'compare populations austin city proper', vec(0x00));
  r.index('parent-b', 'translate this page to spanish', vec(0xff));
}

describe('T19 normalizeTopK clamp (BRAIN TDD)', () => {
  it('clamps bad topK to default 5, floors the rest', () => {
    expect(normalizeTopK(undefined)).toBe(DEFAULT_TOPK);
    expect(normalizeTopK(0)).toBe(DEFAULT_TOPK);
    expect(normalizeTopK(-3)).toBe(DEFAULT_TOPK);
    expect(normalizeTopK(NaN)).toBe(DEFAULT_TOPK);
    expect(normalizeTopK(Infinity)).toBe(DEFAULT_TOPK);
    expect(normalizeTopK(2.9)).toBe(2);
    expect(normalizeTopK(5)).toBe(5);
  });
});

describe('T19 dedup-before-slice length≤topK (BRAIN TDD)', () => {
  it('collapses child hits to one parent before slicing, on every entry', () => {
    for (const run of [
      (r: HybridRetriever) => r.query({ text: 'austin city proper populations', topK: 1 }),
      (r: HybridRetriever) => r.queryTopK({ text: 'austin city proper populations' }, 1),
      (r: HybridRetriever) => r.queryCascade({ text: 'austin city proper populations', topK: 1 }),
      (r: HybridRetriever) =>
        r.queryCascade({ text: 'austin city proper populations', vec512: vec(0x00), topK: 1 }),
      (r: HybridRetriever) =>
        retrieveThreaded(r, { text: 'austin city proper populations', topK: 1 }),
    ]) {
      const r = new HybridRetriever();
      seedParentChild(r);
      const hits = run(r);
      expect(hits).toHaveLength(1);
      expect(hits[0].anchor).toBe('parent-a');
    }
  });

  it('bounds every entry to topK with the parent appearing once', () => {
    for (const run of [
      (r: HybridRetriever) => r.query({ text: 'austin city proper populations', topK: 5 }),
      (r: HybridRetriever) => r.queryTopK({ text: 'austin city proper populations' }, 5),
      (r: HybridRetriever) => r.queryCascade({ text: 'austin city proper populations', topK: 5 }),
      (r: HybridRetriever) =>
        retrieveThreaded(r, { text: 'austin city proper populations', topK: 5 }),
    ]) {
      const r = new HybridRetriever();
      seedParentChild(r);
      const hits = run(r);
      expect(hits.length).toBeLessThanOrEqual(5);
      expect(hits.filter((h) => h.anchor === 'parent-a')).toHaveLength(1);
    }
  });
});

describe('T19 RRF-60 + FLAT preserved (BRAIN TDD)', () => {
  it('pins RRF K=60 and keeps both ranking modes', () => {
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
    const threaded = retrieveThreaded(
      r,
      { text: 'compare populations', vec512: vec(0x00), topK: 2 },
    );
    for (const h of threaded) expect(h.mode).toBe('RRF');
    expect(threaded[0].anchor).toBe('anchor-a');
  });
});

describe('T19 cascade order (BRAIN TDD)', () => {
  it('cutoff keeps a subsequence of the full order; threaded entry matches cascade', () => {
    const r = new HybridRetriever();
    seed7(r);
    const q = { text: 'river populations handbook', vec512: vec(0), topK: 7 };
    const full = r.queryCascade(q, 5, Number.NEGATIVE_INFINITY);
    const cut = r.queryCascade(q, 5, 0.032);
    expect(cut.length).toBeGreaterThan(0);
    expect(cut.length).toBeLessThan(full.length);
    const fullOrder = full.map((h) => h.anchor);
    let j = 0;
    for (const a of cut.map((h) => h.anchor)) {
      const k = fullOrder.indexOf(a, j);
      expect(k).toBeGreaterThanOrEqual(j);
      j = k + 1;
    }
    // Threaded entry threads the same bounds: identical to cascade defaults.
    const threaded = retrieveThreaded(r, q);
    expect(threaded.map((h) => h.anchor)).toEqual(
      r.queryCascade(q).map((h) => h.anchor),
    );
    expect(threaded.length).toBeLessThanOrEqual(normalizeTopK(q.topK));
  });

  it('cutoff default drops the tail without reordering', () => {
    const r = new HybridRetriever();
    seed7(r);
    const q = { text: 'river populations handbook', vec512: vec(0), topK: 7 };
    const full = r.queryCascade(q, 5, Number.NEGATIVE_INFINITY);
    const cut = r.queryCascade(q, 5, CASCADE_SCORE_CUTOFF);
    expect(cut.length).toBeLessThanOrEqual(full.length);
    const order = full.map((h) => h.anchor);
    let j = 0;
    for (const a of cut.map((h) => h.anchor)) {
      const k = order.indexOf(a, j);
      expect(k).toBeGreaterThanOrEqual(j);
      j = k + 1;
    }
  });
});

describe('T19 UD/bench harness 0-LLM (BRAIN TDD)', () => {
  it('pins the exact sampling allowlist: cache_prompt on, no speculative keys', () => {
    const o = buildOllamaOptions();
    expect(o).toEqual({ temperature: 1.0, top_p: 0.95, top_k: 64, cache_prompt: true });
    // No speculative-decoding / drafting keys — allowlist stays tight (llama-only cache).
    for (const k of Object.keys(o)) {
      expect(k).not.toMatch(/speculative|draft|ngram|predict/i);
    }
  });

  it('honors the cachePrompt opt-out without adding keys', () => {
    const o = buildOllamaOptions({ cachePrompt: false });
    expect(o.cache_prompt).toBe(false);
    expect(Object.keys(o).sort()).toEqual(['cache_prompt', 'temperature', 'top_k', 'top_p']);
  });

  it('threads numCtx with the OLLAMA_CONTEXT_LENGTH clamp', () => {
    const prev = process.env.OLLAMA_CONTEXT_LENGTH;
    try {
      delete process.env.OLLAMA_CONTEXT_LENGTH;
      expect(buildOllamaOptions({ numCtx: 32768 }).num_ctx).toBe(32768);
      process.env.OLLAMA_CONTEXT_LENGTH = '16384';
      expect(buildOllamaOptions({ numCtx: 32768 }).num_ctx).toBe(16384);
    } finally {
      if (prev === undefined) delete process.env.OLLAMA_CONTEXT_LENGTH;
      else process.env.OLLAMA_CONTEXT_LENGTH = prev;
    }
    expect(buildOllamaOptions().num_ctx).toBeUndefined();
  });

  it('is pure config: no client, no fetch, no model calls', () => {
    // This file never imports OllamaClient and never touches fetch — building
    // the UD/bench request options is pure computation (0 LLM calls).
    expect(typeof buildOllamaOptions).toBe('function');
    expect(typeof retrieveThreaded).toBe('function');
    expect(buildOllamaOptions({ temperature: 0.5 }).temperature).toBe(0.5);
  });
});
