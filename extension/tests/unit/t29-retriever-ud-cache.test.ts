// T29 retriever threading + UD/n-gram/cache pins (BRAIN TDD, 0 LLM calls).
// Pins: normalizeTopK clamp, dedup-before-slice length<=topK, RRF-60 +
// FLAT preserved, retrieveThreaded threading (same ranking as queryCascade,
// bounds threaded), and the UD/bench-harness pure-config seam
// (cache_prompt pinned true, no speculative keys, llama-only n-gram docs).
// Pure stubs only: no OllamaClient instantiation, no fetch, no model calls.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
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

/** One parent with two child chunks + one unrelated parent (dedupe fixture). */
function seedParentChild(r: HybridRetriever): void {
  r.index('parent-a', 'compare populations of cities anchor source', vec(0x00));
  r.indexChild('parent-a', 'parent-a#c1', 'compare populations austin city proper', vec(0x00));
  r.indexChild('parent-a', 'parent-a#c2', 'compare populations austin city proper', vec(0x00));
  r.index('parent-b', 'translate this page to spanish', vec(0xff));
}

/** Overflow fixture: >topK distinct parents (7 docs, all keyword-matching). */
function seedOverflow(r: HybridRetriever): void {
  for (let i = 0; i < 7; i += 1) {
    r.index(`overflow-${i}`, `river populations handbook entry number ${i}`, vec(i));
  }
}

describe('T29 normalizeTopK clamp (BRAIN TDD)', () => {
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

describe('T29 dedup-before-slice length<=topK (BRAIN TDD)', () => {
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

  it('overflow fixture (>topK distinct parents) bounds every entry with no dupes', () => {
    const topK = 3;
    const text = 'river populations handbook';
    const runs: Array<(r: HybridRetriever) => { anchor: string }[]> = [
      (r: HybridRetriever) => r.query({ text, topK }),
      (r: HybridRetriever) => r.queryTopK({ text }, topK),
      (r: HybridRetriever) => r.queryCascade({ text, topK }),
      (r: HybridRetriever) => r.queryCascade({ text, vec512: vec(0x00), topK }),
      (r: HybridRetriever) => retrieveThreaded(r, { text, topK }),
      (r: HybridRetriever) => retrieveThreaded(r, { text, vec512: vec(0x00), topK }),
    ];
    for (const run of runs) {
      const r = new HybridRetriever();
      seedOverflow(r);
      const hits = run(r);
      // 7 distinct parents vs topK 3: the slice must actually cut.
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.length).toBeLessThanOrEqual(topK);
      expect(new Set(hits.map((h) => h.anchor)).size).toBe(hits.length);
    }
  });
});

describe('T29 RRF-60 + FLAT preserved (BRAIN TDD)', () => {
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

  it('is symmetric across vec512 variants (0x00 <-> 0xff)', () => {
    const r = new HybridRetriever();
    r.index('anchor-a', 'compare populations of cities', vec(0x00));
    r.index('anchor-b', 'translate this page to spanish', vec(0xff));
    const fwd = r.query({ text: 'compare populations', vec512: vec(0x00), topK: 2 });
    for (const h of fwd) expect(h.mode).toBe('RRF');
    expect(fwd[0].anchor).toBe('anchor-a');
    const rev = r.query({ text: 'translate spanish page', vec512: vec(0xff), topK: 2 });
    for (const h of rev) expect(h.mode).toBe('RRF');
    expect(rev[0].anchor).toBe('anchor-b');
    const fwdCascade = r.queryCascade(
      { text: 'compare populations', vec512: vec(0x00), topK: 2 },
    );
    expect(fwdCascade[0].anchor).toBe('anchor-a');
    const revCascade = r.queryCascade(
      { text: 'translate spanish page', vec512: vec(0xff), topK: 2 },
    );
    expect(revCascade[0].anchor).toBe('anchor-b');
    const fwdThreaded = retrieveThreaded(
      r,
      { text: 'compare populations', vec512: vec(0x00), topK: 2 },
    );
    for (const h of fwdThreaded) expect(h.mode).toBe('RRF');
    expect(fwdThreaded[0].anchor).toBe('anchor-a');
    const revThreaded = retrieveThreaded(
      r,
      { text: 'translate spanish page', vec512: vec(0xff), topK: 2 },
    );
    for (const h of revThreaded) expect(h.mode).toBe('RRF');
    expect(revThreaded[0].anchor).toBe('anchor-b');
  });
});

describe('T29 threaded entry threads the same bounds (BRAIN TDD)', () => {
  it('matches queryCascade defaults and respects the topK bound', () => {
    const r = new HybridRetriever();
    for (let i = 0; i < 7; i += 1) {
      r.index(`anchor-${i}`, `handbook overview entry number ${i} river populations`, vec(i));
    }
    const q = { text: 'river populations handbook', vec512: vec(0), topK: 7 };
    const threaded = retrieveThreaded(r, q);
    expect(threaded.map((h) => h.anchor)).toEqual(
      r.queryCascade(q).map((h) => h.anchor),
    );
    expect(threaded.length).toBeLessThanOrEqual(normalizeTopK(q.topK));
  });
});

describe('T29 UD/cache pins 0-LLM (BRAIN TDD)', () => {
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

  it('is pure config: no client, no fetch, no model calls', () => {
    // This file never imports OllamaClient and never touches fetch — building
    // the UD/bench request options is pure computation (0 LLM calls).
    expect(typeof buildOllamaOptions).toBe('function');
    expect(typeof retrieveThreaded).toBe('function');
    expect(buildOllamaOptions({ temperature: 0.5 }).temperature).toBe(0.5);
  });

  it('import-blacklist: seam imports only pure config (no OllamaClient)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const self = readFileSync(join(here, 't29-retriever-ud-cache.test.ts'), 'utf8');
    expect(self).not.toMatch(/import\s*{[^}]*\bOllamaClient\b[^}]*}/);
    expect(self).not.toMatch(/new\s+OllamaClient\s*\(/);
  });

  it('retriever + options builder never touch fetch (spy, 0 LLM calls)', () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('fetch must not be called (T29 purity spy)'));
    try {
      const r = new HybridRetriever();
      seedParentChild(r);
      r.query({ text: 'austin city proper populations', topK: 1 });
      r.queryTopK({ text: 'austin city proper populations' }, 1);
      r.queryCascade({ text: 'austin city proper populations', topK: 1 });
      r.queryCascade({ text: 'austin city proper populations', vec512: vec(0x00), topK: 1 });
      retrieveThreaded(r, { text: 'austin city proper populations', topK: 1 });
      buildOllamaOptions();
      buildOllamaOptions({ cachePrompt: false });
      buildOllamaOptions({ temperature: 0.5, topP: 0.9, topK: 32, numCtx: 4096 });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('workflow_memory retriever path is static pure: no fetch/socket/client', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '../../src/agent/workflow_memory.ts'), 'utf8');
    expect(src).not.toMatch(/^\s*import\s.*(provider|fetch|facts|llm)/mi);
    expect(src).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|OllamaClient)\b\s*\(/);
  });

  it('keeps llama-only n-gram/UD keys off the allowlist', () => {
    // n-gram / unconditional-draft decoding is llama-only: the sampling
    // allowlist stays tight (no speculative/draft keys) on every shape.
    for (const o of [
      buildOllamaOptions(),
      buildOllamaOptions({ cachePrompt: false }),
      buildOllamaOptions({ temperature: 0.5, topP: 0.9, topK: 32, numCtx: 4096 }),
    ]) {
      for (const k of Object.keys(o)) {
        expect(k).not.toMatch(/speculative|draft|ngram|predict|unconditional/i);
      }
    }
    expect(Object.keys(buildOllamaOptions()).sort()).toEqual([
      'cache_prompt',
      'temperature',
      'top_k',
      'top_p',
    ]);
  });
});
