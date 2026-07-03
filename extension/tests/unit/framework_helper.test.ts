import { describe, it, expect } from 'vitest';
import { runHelper, runHelperCompaction } from '@/agent/framework/helper';
import { localProvider } from '@/agent/framework/provider';
import { ToolRegistry } from '@/agent/tools/registry';
import { echoTool } from '@/agent/tools/core';
import { makeFakeOllama, rawResponse } from '../helpers';
import type { CommonContext } from '@/agent/prompts';

describe('runHelper', () => {
  it('delegates to runExecutor with the given provider', async () => {
    const fake = makeFakeOllama({
      executor: [rawResponse({ toolCalls: [{ name: 'echo', args: { message: 'hi' } }] })],
    });
    const registry = new ToolRegistry();
    registry.register(echoTool);
    const ctx: CommonContext = {
      goal: 'test',
      toolCatalog: '',
      plan: null,
      currentStepId: null,
      ownedTabs: [],
    };
    const out = await runHelper(localProvider(fake), {
      ctx,
      model: 'x',
      registry,
      toolCtx: {} as never,
    });
    expect(out.tool).toBe('echo');
  });
});

describe('runHelperCompaction', () => {
  it('delegates to runCompactor with the given provider', async () => {
    const fake = makeFakeOllama({
      compactor: [rawResponse({ content: '{"summary":"short"}' })],
    });
    const out = await runHelperCompaction(localProvider(fake), {
      goal: 'test',
      toolCatalog: '',
      scratchpad: 'a very long scratchpad'.repeat(100),
      model: 'x',
    });
    expect(out.summary).toBe('short');
  });
});
