import { describe, expect, it } from 'vitest';
import { ToolRegistry, zodToJsonSchema } from '@/agent/tools/registry';
import { z } from 'zod';

describe('ToolRegistry', () => {
  it('routes args through Zod', async () => {
    const r = new ToolRegistry();
    r.register({
      name: 'add',
      description: 'add two ints',
      argsSchema: z.object({ a: z.number().int(), b: z.number().int() }),
      async dispatch({ a, b }) {
        return { ok: true, content: String(a + b) };
      },
    });
    const ok = await r.dispatch('add', { a: 2, b: 3 }, fakeCtx());
    expect(ok.content).toBe('5');
    const bad = await r.dispatch('add', { a: 'x', b: 3 }, fakeCtx());
    expect(bad.ok).toBe(false);
  });

  it('returns unknownTool: true for unregistered name', async () => {
    const r = new ToolRegistry();
    const res = await r.dispatch('nope', {}, fakeCtx());
    expect(res.unknownTool).toBe(true);
    expect(res.ok).toBe(false);
  });

  it('toolDefs converts Zod to JSON Schema', () => {
    const r = new ToolRegistry();
    r.register({
      name: 't',
      description: 'desc',
      argsSchema: z.object({ x: z.string(), y: z.number().optional() }),
      async dispatch() {
        return { ok: true, content: '' };
      },
    });
    const defs = r.toolDefs();
    expect(defs[0].function.name).toBe('t');
    const params = defs[0].function.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(params.properties.x).toBeDefined();
    expect(params.required).toEqual(['x']);
  });

  it('catches dispatch errors', async () => {
    const r = new ToolRegistry();
    r.register({
      name: 'boom',
      description: '',
      argsSchema: z.object({}),
      async dispatch() {
        throw new Error('exploded');
      },
    });
    const res = await r.dispatch('boom', {}, fakeCtx());
    expect(res.ok).toBe(false);
    expect(res.content).toContain('exploded');
  });
});

describe('zodToJsonSchema', () => {
  it('renders enum', () => {
    const j = zodToJsonSchema(z.object({ x: z.enum(['a', 'b']) })) as { properties: Record<string, { enum?: string[] }> };
    expect(j.properties.x.enum).toEqual(['a', 'b']);
  });
  it('renders array', () => {
    const j = zodToJsonSchema(z.object({ xs: z.array(z.number()) })) as { properties: Record<string, { type?: string; items?: unknown }> };
    expect(j.properties.xs.type).toBe('array');
    expect(j.properties.xs.items).toEqual({ type: 'number' });
  });
});

function fakeCtx(): import('@/agent/tools/registry').ToolContext {
  return {
    taskId: 't',
    signal: new AbortController().signal,
    hot: {
      goal: 'g',
      phase: 'EXECUTING',
      currentStepId: null,
      plan: null,
      replanCount: 0,
      ownedTabs: [],
      lastTouch: Date.now(),
      startedAt: Date.now(),
    },
    settings: {
      ollamaBaseUrl: 'http://localhost:11434',
      plannerModel: 'a',
      executorModel: 'b',
      evaluatorModel: 'c',
      compactorModel: 'd',
      embeddingModel: 'e',
      visionModel: 'f',
      domainTiers: {},
    },
    ollama: {} as never,
    emit: () => undefined,
    addFinding: async () => undefined,
  };
}
