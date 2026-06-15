// Integration: orchestrator end-to-end with a fake OllamaClient and a tiny tool registry.

import { beforeEach, describe, expect, it } from 'vitest';
import { Orchestrator } from '@/agent/orchestrator';
import { ToolRegistry } from '@/agent/tools/registry';
import { z } from 'zod';
import { echoTool, finishTool, nextStepTool } from '@/agent/tools/core';
import { DEFAULT_SETTINGS, type TimelineEvent } from '@/shared/messages';
import { loadHot, clearHot, _setHot } from '@/background/state_store';
import { makeFakeOllama, rawResponse, resetStorage } from '../helpers';

function buildRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(echoTool);
  r.register(nextStepTool);
  r.register(finishTool);
  r.register({
    name: 'noop',
    description: 'do nothing',
    argsSchema: z.object({ note: z.string().optional() }),
    async dispatch({ note }) {
      return { ok: true, content: `noop: ${note ?? ''}` };
    },
  });
  return r;
}

beforeEach(async () => {
  await resetStorage();
  await clearHot();
});

describe('orchestrator — full plan completion', () => {
  it('runs Planner → Executor → next_step → finish path', async () => {
    const planJson = JSON.stringify({
      steps: [
        { description: 'echo hello', successCriteria: 'echoed' },
        { description: 'wrap up', successCriteria: 'finished' },
      ],
    });
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: planJson, promptEvalCount: 100, evalCount: 50 })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'echo', args: { message: 'hello' } }] }),
        rawResponse({ toolCalls: [{ name: 'next_step', args: { reason: 'echoed' } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'done' } }] }),
      ],
      evaluator: [
        rawResponse({
          content: JSON.stringify({ verdict: 'PASS', reason: 'echoed', shouldReplan: false, finishVerdict: null, finishSummary: null }),
        }),
        rawResponse({
          content: JSON.stringify({ verdict: 'PASS', reason: 'wrapped', shouldReplan: false, finishVerdict: 'success', finishSummary: 'done' }),
        }),
      ],
    });

    const events: TimelineEvent[] = [];
    const orch = new Orchestrator({
      ollama,
      registry: buildRegistry(),
      settings: { ...DEFAULT_SETTINGS },
      emit: (e) => events.push(e),
    });
    const initial = await orch.start('find a wireless mouse');
    const result = await orch.runUntilTerminal(initial);
    expect(result.phase).toBe('DONE');
    const hot = await loadHot();
    expect(hot?.phase).toBe('DONE');
    expect(events.some((e) => e.kind === 'finish')).toBe(true);
    expect(events.some((e) => e.kind === 'planner.plan')).toBe(true);
  });
});

describe('orchestrator — goal byte-survival across replan', () => {
  it('goal text is byte-identical after replan + compaction-ish path', async () => {
    const goal = 'Find a wireless mouse under $30 ★';
    const planJson = JSON.stringify({
      steps: [{ description: 'noop forever', successCriteria: 'never' }],
    });
    const replanJson = JSON.stringify({
      steps: [{ description: 'finish via tool', successCriteria: 'done' }],
    });
    const ollama = makeFakeOllama({
      planner: [
        rawResponse({ content: planJson }),
        rawResponse({ content: replanJson }),
      ],
      executor: [
        rawResponse({ toolCalls: [{ name: 'noop', args: { note: 'x' } }] }),
        rawResponse({ toolCalls: [{ name: 'noop', args: { note: 'x' } }] }),
        rawResponse({ toolCalls: [{ name: 'noop', args: { note: 'x' } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'ok' } }] }),
      ],
      evaluator: [
        rawResponse({
          content: JSON.stringify({ verdict: 'FAIL', reason: 'no progress', shouldReplan: false, finishVerdict: null, finishSummary: null }),
        }),
      ],
    });
    const orch = new Orchestrator({
      ollama,
      registry: buildRegistry(),
      settings: { ...DEFAULT_SETTINGS },
      emit: () => undefined,
      maxReplans: 3,
      maxStepTurns: 12,
    });
    const initial = await orch.start(goal);
    await orch.runUntilTerminal(initial);
    const hot = await loadHot();
    expect(hot?.goal).toBe(goal);
  });
});

describe('orchestrator — circuit breaker forces replan', () => {
  it('after 3 identical actions, planner is called again', async () => {
    let plannerCalls = 0;
    const ollama = makeFakeOllama(
      {
        planner: [
          rawResponse({
            content: JSON.stringify({ steps: [{ description: 'loop', successCriteria: 'never' }] }),
          }),
          rawResponse({
            content: JSON.stringify({ steps: [{ description: 'finish', successCriteria: 'done' }] }),
          }),
        ],
        executor: [
          rawResponse({ toolCalls: [{ name: 'noop', args: { x: 1 } }] }),
          rawResponse({ toolCalls: [{ name: 'noop', args: { x: 1 } }] }),
          rawResponse({ toolCalls: [{ name: 'noop', args: { x: 1 } }] }),
          rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'done' } }] }),
        ],
        evaluator: [],
      },
      {
        onChat: (_m, r) => {
          if (r === 'planner') plannerCalls++;
        },
      },
    );
    const orch = new Orchestrator({
      ollama,
      registry: buildRegistry(),
      settings: { ...DEFAULT_SETTINGS },
      emit: () => undefined,
    });
    const initial = await orch.start('test');
    await orch.runUntilTerminal(initial);
    expect(plannerCalls).toBeGreaterThanOrEqual(2);
  });
});

describe('orchestrator — empty tool call retry', () => {
  it('produces an unknown-tool storm trip on persistent empty calls', async () => {
    const ollama = makeFakeOllama({
      planner: [
        rawResponse({
          content: JSON.stringify({ steps: [{ description: 'try', successCriteria: 'x' }] }),
        }),
        rawResponse({
          content: JSON.stringify({ steps: [{ description: 'try', successCriteria: 'x' }] }),
        }),
        rawResponse({
          content: JSON.stringify({ steps: [{ description: 'try', successCriteria: 'x' }] }),
        }),
      ],
      executor: [
        rawResponse({ content: 'I think I should... but no.' }),
        rawResponse({ content: 'still no' }),
        rawResponse({ content: 'a' }),
        rawResponse({ content: 'b' }),
        rawResponse({ content: 'c' }),
        rawResponse({ content: 'd' }),
      ],
      evaluator: [],
    });
    const orch = new Orchestrator({
      ollama,
      registry: buildRegistry(),
      settings: { ...DEFAULT_SETTINGS },
      emit: () => undefined,
      maxReplans: 2,
      maxStepTurns: 4,
    });
    const initial = await orch.start('test');
    const r = await orch.runUntilTerminal(initial);
    expect(r.phase).toBe('ABORTED');
  });
});

describe('orchestrator — clear state on abort', () => {
  it('marks phase ABORTED via user abort', async () => {
    const ac = new AbortController();
    const ollama = makeFakeOllama({
      planner: [
        rawResponse({
          content: JSON.stringify({ steps: [{ description: 'a', successCriteria: 'x' }] }),
        }),
      ],
      executor: [
        rawResponse({ toolCalls: [{ name: 'noop', args: {} }] }),
        rawResponse({ toolCalls: [{ name: 'noop', args: {} }] }),
      ],
      evaluator: [],
    });
    const orch = new Orchestrator({
      ollama,
      registry: buildRegistry(),
      settings: { ...DEFAULT_SETTINGS },
      emit: () => undefined,
      signal: ac.signal,
    });
    const initial = await orch.start('test');
    setTimeout(() => ac.abort(new DOMException('user', 'AbortError')), 10);
    await orch.runUntilTerminal(initial).catch(() => undefined);
    await orch.abort('user');
    const hot = await loadHot();
    expect(hot?.phase === 'ABORTED' || hot?.phase === 'DONE').toBe(true);
  });
});

describe('hot-state invariant: _setHot stores exact bytes', () => {
  it('round-trips unicode + emoji + edge whitespace', async () => {
    const goal = '  📚 Compare libraries — α/β/γ with “smart quotes”  ';
    await _setHot(goal);
    const hot = await loadHot();
    expect(hot?.goal).toBe(goal);
  });
});

describe('orchestrator — carries the full page read into later executor turns', () => {
  it('re-injects the most recent read as CURRENT PAGE CONTENT so synthesis sees data beyond the scratchpad tail', async () => {
    // The marker sits ~1200 chars into the page — past the 800-char scratchpad
    // slice and the 200-char recentActions slice — so it can ONLY reach a later
    // turn via the pageContentBlock carry-forward. If that regresses, the marker
    // disappears from the report turn and this test fails. This is the exact bug
    // that made the executor unable to synthesize from a page it had just read.
    const MARKER = 'ZZZ_UNIQUE_PRODUCT Logitech M185 $13.42';
    const longPage = `PAGE_TOP ${'filler '.repeat(170)}${MARKER} tail`;

    const reg = buildRegistry();
    reg.register({
      name: 'aria.extract',
      description: 'extract the page',
      argsSchema: z.object({ tabId: z.number().int().optional() }),
      async dispatch() {
        return { ok: true, content: longPage, data: { url: 'https://example.test/results' } };
      },
    });

    const execPrompts: string[] = [];
    const ollama = makeFakeOllama(
      {
        planner: [
          rawResponse({
            content: JSON.stringify({
              steps: [
                { description: 'read the results page', successCriteria: 'page read' },
                { description: 'report the top product', successCriteria: 'reported' },
              ],
            }),
          }),
        ],
        executor: [
          rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }),
          rawResponse({ toolCalls: [{ name: 'next_step', args: { reason: 'page read' } }] }),
          rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'reported M185' } }] }),
        ],
        evaluator: [
          rawResponse({
            content: JSON.stringify({ verdict: 'PASS', reason: 'page read', shouldReplan: false, finishVerdict: null, finishSummary: null }),
          }),
        ],
      },
      { onChat: (_m, role, messages) => { if (role === 'executor') execPrompts.push(JSON.stringify(messages)); } },
    );

    const orch = new Orchestrator({
      ollama,
      registry: reg,
      settings: { ...DEFAULT_SETTINGS },
      emit: () => undefined,
    });
    const initial = await orch.start('find the cheapest wireless mouse and report it');
    const result = await orch.runUntilTerminal(initial);

    expect(result.phase).toBe('DONE');
    expect(execPrompts.length).toBeGreaterThanOrEqual(2);
    // Turn 1 IS the extract: the page has not been read yet, so the marker is absent.
    expect(execPrompts[0].includes(MARKER)).toBe(false);
    // Every later turn must carry the full read forward under CURRENT PAGE CONTENT.
    const later = execPrompts.slice(1).join('\n');
    expect(later).toContain('CURRENT PAGE CONTENT');
    expect(later).toContain(MARKER);
  });
});

describe('orchestrator — observe-then-act gate', () => {
  it('blocks repeating the same observation tool back-to-back within a step', async () => {
    const reg = buildRegistry();
    reg.register({
      name: 'aria.extract',
      description: 'extract the page',
      argsSchema: z.object({ tabId: z.number().int().optional() }),
      async dispatch() {
        return { ok: true, content: 'PAGE: [1] link "X"' };
      },
    });

    const execTools: string[][] = [];
    const ollama = makeFakeOllama(
      {
        planner: [
          rawResponse({
            content: JSON.stringify({ steps: [{ description: 'read and report', successCriteria: 'done' }] }),
          }),
        ],
        executor: [
          rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }),
          rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'X' } }] }),
        ],
        evaluator: [],
      },
      { onChat: (_m, role, _msgs, toolNames) => { if (role === 'executor') execTools.push(toolNames); } },
    );

    const orch = new Orchestrator({ ollama, registry: reg, settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const initial = await orch.start('read the page and report');
    const result = await orch.runUntilTerminal(initial);

    expect(result.phase).toBe('DONE');
    expect(execTools.length).toBeGreaterThanOrEqual(2);
    expect(execTools[0]).toContain('aria.extract'); // first turn: observation offered
    expect(execTools[1]).not.toContain('aria.extract'); // after observing: gated → must act/answer
  });

  it('auto-re-extracts the page after a navigating action (model never re-uses a stale index)', async () => {
    let ariaCalls = 0;
    const reg = buildRegistry();
    reg.register({
      name: 'aria.extract',
      description: 'extract the page',
      argsSchema: z.object({ tabId: z.number().int().optional() }),
      async dispatch() {
        ariaCalls += 1;
        return { ok: true, content: `PAGE snapshot ${ariaCalls}`, data: { url: 'https://x/' } };
      },
    });
    reg.register({
      name: 'tab.click',
      description: 'click an element',
      argsSchema: z.object({ tabId: z.number().int(), elementIndex: z.number().int() }),
      async dispatch() {
        return { ok: true, content: 'Clicked' };
      },
    });

    const ollama = makeFakeOllama({
      planner: [
        rawResponse({
          content: JSON.stringify({ steps: [{ description: 'click and report', successCriteria: 'done' }] }),
        }),
      ],
      executor: [
        rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }),
        rawResponse({ toolCalls: [{ name: 'tab.click', args: { tabId: 1, elementIndex: 5 } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'X' } }] }),
      ],
      evaluator: [],
    });

    const orch = new Orchestrator({ ollama, registry: reg, settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const initial = await orch.start('click the first result and report it');
    const result = await orch.runUntilTerminal(initial);

    expect(result.phase).toBe('DONE');
    // model called aria.extract once; the harness auto-extracted again after tab.click
    expect(ariaCalls).toBeGreaterThanOrEqual(2);
  });
});

describe('orchestrator — workflow memory', () => {
  it('injects a matched recipe into the planner prompt', async () => {
    const plannerMsgs: string[] = [];
    const ollama = makeFakeOllama(
      {
        planner: [
          rawResponse({
            content: JSON.stringify({ steps: [{ description: 'open and report', successCriteria: 'done' }] }),
          }),
        ],
        executor: [rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'X' } }] })],
        evaluator: [],
      },
      { onChat: (_m, role, messages) => { if (role === 'planner') plannerMsgs.push(JSON.stringify(messages)); } },
    );
    const orch = new Orchestrator({
      ollama,
      registry: buildRegistry(),
      settings: { ...DEFAULT_SETTINGS },
      emit: () => undefined,
    });
    // goal contains box/click/product → matches the seeded on-page recipe
    const initial = await orch.start('go to amazon.com, use the search box, click the first product, report its price');
    await orch.runUntilTerminal(initial);
    expect(plannerMsgs[0]).toContain('known-good sequence');
  });

  it('does not inject a recipe for an unrelated goal', async () => {
    const plannerMsgs: string[] = [];
    const ollama = makeFakeOllama(
      {
        planner: [
          rawResponse({ content: JSON.stringify({ steps: [{ description: 'do it', successCriteria: 'done' }] }) }),
        ],
        executor: [rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'X' } }] })],
        evaluator: [],
      },
      { onChat: (_m, role, messages) => { if (role === 'planner') plannerMsgs.push(JSON.stringify(messages)); } },
    );
    const orch = new Orchestrator({
      ollama,
      registry: buildRegistry(),
      settings: { ...DEFAULT_SETTINGS },
      emit: () => undefined,
    });
    const initial = await orch.start('summarize this article');
    await orch.runUntilTerminal(initial);
    expect(plannerMsgs[0]).not.toContain('known-good sequence');
  });
});
