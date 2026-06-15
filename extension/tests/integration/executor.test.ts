import { describe, expect, it } from 'vitest';
import { _pickToolCall, runExecutor } from '@/agent/roles/executor';
import { ToolRegistry } from '@/agent/tools/registry';
import { z } from 'zod';
import { makeFakeOllama, rawResponse } from '../helpers';
import { DEFAULT_SETTINGS } from '@/shared/messages';
import type { ToolContext } from '@/agent/tools/registry';

function reg(): ToolRegistry {
  const r = new ToolRegistry();
  r.register({
    name: 'do_thing',
    description: 'do a thing',
    argsSchema: z.object({ x: z.number() }),
    async dispatch({ x }) {
      return { ok: true, content: `did ${x}` };
    },
  });
  return r;
}

function fakeCtx(): ToolContext {
  return {
    taskId: 't',
    signal: new AbortController().signal,
    hot: {
      goal: 'g',
      phase: 'EXECUTING',
      currentStepId: 'sid',
      plan: null,
      replanCount: 0,
      ownedTabs: [],
      lastTouch: Date.now(),
      startedAt: Date.now(),
    },
    settings: { ...DEFAULT_SETTINGS },
    ollama: {} as never,
    emit: () => undefined,
    addFinding: async () => undefined,
  };
}

describe('runExecutor', () => {
  it('dispatches first tool call', async () => {
    const ollama = makeFakeOllama({
      executor: [rawResponse({ toolCalls: [{ name: 'do_thing', args: { x: 7 } }] })],
    });
    const out = await runExecutor({
      ctx: { goal: 'g', toolCatalog: '', plan: null, currentStepId: null, ownedTabs: [] },
      model: 'm',
      ollama,
      registry: reg(),
      toolCtx: fakeCtx(),
    });
    expect(out.tool).toBe('do_thing');
    expect(out.result.ok).toBe(true);
    expect(out.retryUsed).toBe(false);
  });

  it('retries with assistant-failed + nudge when first call has no tool', async () => {
    const ollama = makeFakeOllama({
      executor: [
        rawResponse({ content: 'I will think about it' }),
        rawResponse({ toolCalls: [{ name: 'do_thing', args: { x: 1 } }] }),
      ],
    });
    const out = await runExecutor({
      ctx: { goal: 'g', toolCatalog: '', plan: null, currentStepId: null, ownedTabs: [] },
      model: 'm',
      ollama,
      registry: reg(),
      toolCtx: fakeCtx(),
    });
    expect(out.retryUsed).toBe(true);
    expect(out.tool).toBe('do_thing');
  });

  it('flags unknownTool when model invents tool name', async () => {
    const ollama = makeFakeOllama({
      executor: [rawResponse({ toolCalls: [{ name: 'imaginary_tool', args: {} }] })],
    });
    const out = await runExecutor({
      ctx: { goal: 'g', toolCatalog: '', plan: null, currentStepId: null, ownedTabs: [] },
      model: 'm',
      ollama,
      registry: reg(),
      toolCtx: fakeCtx(),
    });
    expect(out.result.unknownTool).toBe(true);
  });

  it('treats a substantial prose answer (no tool call) as an answer that advances the step', async () => {
    const answer =
      'Here are the top 3 wireless mice: 1. Logitech M185 — $13.42, 2. Logitech M510 — $27.99, 3. Logitech MX Master 4 — $119.99.';
    const ollama = makeFakeOllama({
      executor: [rawResponse({ content: answer }), rawResponse({ content: answer })],
    });
    const out = await runExecutor({
      ctx: { goal: 'g', toolCatalog: '', plan: null, currentStepId: null, ownedTabs: [] },
      model: 'm',
      ollama,
      registry: reg(),
      toolCtx: fakeCtx(),
    });
    expect(out.tool).toBe('answer');
    expect(out.result.advanceStep).toBe(true);
    expect(out.result.content).toContain('Logitech M510');
    expect(out.result.unknownTool).toBeFalsy();
  });

  it('still flags empty/short output as unknownTool (breaker safety)', async () => {
    const ollama = makeFakeOllama({
      executor: [rawResponse({ content: '' }), rawResponse({ content: 'no' })],
    });
    const out = await runExecutor({
      ctx: { goal: 'g', toolCatalog: '', plan: null, currentStepId: null, ownedTabs: [] },
      model: 'm',
      ollama,
      registry: reg(),
      toolCtx: fakeCtx(),
    });
    expect(out.result.unknownTool).toBe(true);
  });

  it('does NOT dispatch a tool the toolFilter blocks, even if the model emits it', async () => {
    const ollama = makeFakeOllama({
      executor: [
        rawResponse({ toolCalls: [{ name: 'do_thing', args: { x: 1 } }] }),
        rawResponse({ toolCalls: [{ name: 'do_thing', args: { x: 2 } }] }),
      ],
    });
    const out = await runExecutor({
      ctx: { goal: 'g', toolCatalog: '', plan: null, currentStepId: null, ownedTabs: [] },
      model: 'm',
      ollama,
      registry: reg(),
      toolCtx: fakeCtx(),
      toolFilter: (name) => name !== 'do_thing', // observe-then-act gate blocks it
    });
    expect(out.tool).not.toBe('do_thing'); // blocked tool never dispatched
    expect(out.result.unknownTool).toBe(true);
  });
});

describe('_pickToolCall', () => {
  it('parses {tool,args} JSON from free text as last resort', () => {
    const r = reg();
    const picked = _pickToolCall([], JSON.stringify({ tool: 'do_thing', args: { x: 5 } }), r);
    expect(picked?.name).toBe('do_thing');
    expect(picked?.args).toEqual({ x: 5 });
  });
});
