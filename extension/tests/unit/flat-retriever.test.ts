import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '@/agent/tools/registry';
import {
  FLAT_FALLBACK,
  HybridRetriever,
  flattenJsonSchema,
  flattenToolCatalog,
  hasNestedAnyOf,
  parentForTool,
} from '@/agent/workflow_memory';
import type { FlatToolEntry } from '@/shared/messages';
import { PAGE_CHILD_TOOLS, PAGE_PARENT } from '@/agent/tools/browser/page';

function vec(fill: number): Uint8Array {
  return new Uint8Array(64).fill(fill);
}

describe('T9 flat MCP catalog (BRAIN TDD)', () => {
  it('flattens registry tool schemas so no nested anyOf remains', () => {
    const r = new ToolRegistry();
    r.register({
      name: 'nested',
      description: 'tool with nested unions',
      argsSchema: z.object({
        // union at property level -> anyOf nested inside properties
        x: z.union([z.string(), z.number()]),
        nested: z.object({
          y: z.union([z.string(), z.boolean()]),
        }),
      }),
      async dispatch() {
        return { ok: true, content: '' };
      },
    });
    const defs = r.toolDefs();
    const rawParams = defs[0].function.parameters as Record<string, unknown>;
    // Sanity: the raw registry schema really does nest anyOf (or the test is vacuous).
    expect(JSON.stringify(rawParams)).toContain('anyOf');

    const flat = flattenToolCatalog(defs);
    expect(flat.length).toBe(1);
    const entry: FlatToolEntry = flat[0];
    expect(entry.name).toBe('nested');
    // Flattened parameters must contain no nested anyOf anywhere.
    expect(hasNestedAnyOf(entry.parameters)).toBe(false);
    expect(JSON.stringify(entry.parameters)).not.toContain('anyOf');
  });

  it('flattenJsonSchema lifts nested anyOf to a flat shape', () => {
    const nested = {
      type: 'object',
      properties: {
        x: { anyOf: [{ type: 'string' }, { anyOf: [{ type: 'number' }, { type: 'boolean' }] }] },
      },
    };
    expect(hasNestedAnyOf(nested)).toBe(true);
    const flat = flattenJsonSchema(nested);
    expect(hasNestedAnyOf(flat)).toBe(false);
    expect(JSON.stringify(flat)).not.toContain('anyOf');
  });

  it('page child tools share one flat parent for grouping', () => {
    expect(PAGE_PARENT).toBe('page');
    expect(PAGE_CHILD_TOOLS).toContain('dom.query');
    expect(PAGE_CHILD_TOOLS).toContain('page.wait_for');
  });

  it('parentForTool stays in sync with PAGE_* grouping (single source)', () => {
    // Dual-source guard: the prefix rule must agree with the explicit list.
    for (const child of PAGE_CHILD_TOOLS) expect(parentForTool(child)).toBe(PAGE_PARENT);
    expect(parentForTool('tab.open')).toBeUndefined();
    expect(parentForTool('search')).toBeUndefined();
    expect(parentForTool('aria.extract')).toBeUndefined();
  });

  it('flattenJsonSchema collapses oneOf like anyOf', () => {
    const nested = {
      type: 'object',
      properties: { x: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
    };
    expect(hasNestedAnyOf(nested)).toBe(true);
    const flat = flattenJsonSchema(nested);
    expect(hasNestedAnyOf(flat)).toBe(false);
    expect(JSON.stringify(flat)).not.toContain('oneOf');
  });
});

describe('T9 parent_child retriever (BRAIN TDD)', () => {
  it('index returns parent anchor on child hit', () => {
    const r = new HybridRetriever();
    r.index('parent-a', 'compare populations of cities anchor source', vec(0x00));
    r.indexChild('parent-a', 'parent-a#chunk-1', 'compare populations austin city proper', vec(0x00));
    r.index('parent-b', 'translate this page to spanish', vec(0xff));
    const hits = r.query({ text: 'austin city proper populations', topK: 5 });
    expect(hits.length).toBeGreaterThan(0);
    // Child hit must resolve to its parent anchor.
    expect(hits[0].anchor).toBe('parent-a');
    // ...with the PARENT summary (parent was indexed), not the chunk text.
    expect(hits[0].summary).toBe('compare populations of cities anchor source');
  });

  it('recall@5: target parent ranks in top 5 of 12 (non-vacuous)', () => {
    const r = new HybridRetriever();
    // 12 parents × distinct 3-word child fingerprints (every word length>2,
    // non-stopword, so tokenize keeps each as a discriminating token).
    const fingerprints: Array<[string, string, string]> = [
      ['alpine', 'meadow', 'falcon'],
      ['harbor', 'lantern', 'cobalt'],
      ['canyon', 'ember', 'willow'],
      ['prairie', 'quartz', 'badger'],
      ['tundra', 'opal', 'raven'],
      ['savanna', 'granite', 'heron'],
      ['glacier', 'copper', 'otter'],
      ['volcano', 'jasper', 'eagle'],
      ['lagoon', 'basalt', 'crane'],
      ['summit', 'shale', 'bison'],
      ['delta', 'flint', 'cobra'],
      ['fjord', 'sandstone', 'viper'],
    ];
    fingerprints.forEach(([a, b, c], i) => {
      const parent = `parent-${i}`;
      r.index(parent, 'municipal handbook overview entry', vec(i));
      r.indexChild(parent, `${parent}#c0`, `${a} ${b} ${c} river populations`, vec(i));
    });
    // 12 docs but topK 5: only a real ranking puts the target here
    // (the old topK-10-over-10-docs shape passed by returning everything).
    const target = 7;
    const [ta, tb, tc] = fingerprints[target];
    const hits = r.query({ text: `${ta} ${tb} ${tc} populations`, vec512: vec(target), topK: 5 });
    expect(hits.length).toBeLessThanOrEqual(5);
    expect(hits.map((h) => h.anchor)).toContain(`parent-${target}`);
  });

  it('FLAT_FALLBACK preserved: parent mapping works without a query vector', () => {
    const r = new HybridRetriever();
    r.index('parent-a', 'compare populations of cities', vec(0x00));
    r.indexChild('parent-a', 'parent-a#chunk-1', 'austin city proper figure', vec(0x00));
    r.index('parent-b', 'translate this page to spanish', vec(0xff));
    const hits = r.query({ text: 'austin city proper' });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.mode).toBe(FLAT_FALLBACK);
    expect(hits[0].anchor).toBe('parent-a');
  });
});
