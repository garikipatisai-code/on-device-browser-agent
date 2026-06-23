// Integration: orchestrator end-to-end with a fake OllamaClient and a tiny tool registry.

import { beforeEach, describe, expect, it } from 'vitest';
import { Orchestrator } from '@/agent/orchestrator';
import { ToolRegistry } from '@/agent/tools/registry';
import { z } from 'zod';
import { echoTool, finishTool, nextStepTool } from '@/agent/tools/core';
import { DEFAULT_SETTINGS, type TimelineEvent } from '@/shared/messages';
import { loadHot, clearHot, _setHot } from '@/background/state_store';
import { loadWorkflows, upsertUserWorkflow, markWorkflowTrusted, type Workflow } from '@/agent/workflow_memory';
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
    const goal = 'Tidy up the kitchen drawer ★';
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
    const initial = await orch.start('tell me a joke about cats');
    await orch.runUntilTerminal(initial);
    expect(plannerMsgs[0]).not.toContain('known-good sequence');
  });
});

describe('orchestrator — auto-read visibility', () => {
  it('emits a timeline log for the post-navigation auto-read, after the action that triggered it', async () => {
    const reg = buildRegistry();
    reg.register({
      name: 'aria.extract',
      description: 'extract the page',
      argsSchema: z.object({ tabId: z.number().int().optional() }),
      async dispatch() {
        return { ok: true, content: 'PAGE: heading "Product" price "£9.99"', data: { url: 'https://x/p' } };
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

    const events: TimelineEvent[] = [];
    const ollama = makeFakeOllama({
      planner: [
        rawResponse({ content: JSON.stringify({ steps: [{ description: 'click and report', successCriteria: 'done' }] }) }),
      ],
      executor: [
        rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }),
        rawResponse({ toolCalls: [{ name: 'tab.click', args: { tabId: 1, elementIndex: 2 } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'reported' } }] }),
      ],
      evaluator: [],
    });

    const orch = new Orchestrator({ ollama, registry: reg, settings: { ...DEFAULT_SETTINGS }, emit: (e) => events.push(e) });
    const initial = await orch.start('click the product and report its price');
    const result = await orch.runUntilTerminal(initial);
    expect(result.phase).toBe('DONE');

    // The auto-read used to be invisible (dispatched directly, never emitted) — which
    // made it impossible to tell whether an answer was grounded or guessed.
    const autoReadIdx = events.findIndex((e) => e.kind === 'log' && /auto-read/i.test(e.message));
    expect(autoReadIdx).toBeGreaterThanOrEqual(0);
    const log = events[autoReadIdx] as Extract<TimelineEvent, { kind: 'log' }>;
    expect(log.level).toBe('info');

    // It must come AFTER the tab.click result that triggered it (chronological order).
    const clickIdx = events.findIndex((e) => e.kind === 'tool.result' && e.tool === 'tab.click');
    expect(clickIdx).toBeGreaterThanOrEqual(0);
    expect(autoReadIdx).toBeGreaterThan(clickIdx);
  });
});

describe('orchestrator — verified finish', () => {
  function pageReg(content: string) {
    const reg = buildRegistry();
    reg.register({
      name: 'aria.extract',
      description: 'extract the page',
      argsSchema: z.object({ tabId: z.number().int().optional() }),
      async dispatch() {
        return { ok: true, content, data: { url: 'https://x/' } };
      },
    });
    return reg;
  }

  it('downgrades to partial when a finish asserts a number not on any page read', async () => {
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'read and report', successCriteria: 'done' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'The price is £99.99' } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'The price is £99.99' } }] }),
      ],
      evaluator: [],
    });
    const orch = new Orchestrator({ ollama, registry: pageReg('Widget — in stock, no price shown'), settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const result = await orch.runUntilTerminal(await orch.start('report the price'));
    expect(result.verdict).toBe('partial');
    expect(result.summary).toContain('unverified against page');
  });

  it('accepts a finish whose numbers are all grounded', async () => {
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'read and report', successCriteria: 'done' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'The price is £99.99' } }] }),
      ],
      evaluator: [],
    });
    const orch = new Orchestrator({ ollama, registry: pageReg('Widget price £99.99 in stock'), settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const result = await orch.runUntilTerminal(await orch.start('report the price'));
    expect(result.verdict).toBe('success');
  });

  it('skips verification for an honest blocked finish', async () => {
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'find it', successCriteria: 'done' }] }) })],
      executor: [rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'blocked', summary: 'No such product was found.' } }] })],
      evaluator: [],
    });
    const orch = new Orchestrator({ ollama, registry: pageReg('anything'), settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const result = await orch.runUntilTerminal(await orch.start('find the blender'));
    expect(result.verdict).toBe('blocked');
  });

  it('self-corrects: an ungrounded number is rejected, then a grounded re-finish passes', async () => {
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'read and report', successCriteria: 'done' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'The price is £99.99' } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'The price is £10.00' } }] }),
      ],
      evaluator: [],
    });
    const orch = new Orchestrator({ ollama, registry: pageReg('Widget price £10.00 in stock'), settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const result = await orch.runUntilTerminal(await orch.start('report the price'));
    expect(result.verdict).toBe('success');
    expect(result.summary).toContain('10.00');
  });
});

describe('orchestrator — consent/modal dismissal', () => {
  function consentReg(wall: string, content: string) {
    let dismissed = false;
    const reg = buildRegistry();
    reg.register({
      name: 'tab.open',
      description: 'open a tab',
      argsSchema: z.object({ url: z.string() }),
      async dispatch({ url }) {
        return { ok: true, content: `Opened ${url}`, data: { tabId: 777, url } };
      },
    });
    reg.register({
      name: 'aria.extract',
      description: 'extract the page',
      argsSchema: z.object({ tabId: z.number().int().optional() }),
      async dispatch() {
        return { ok: true, content: dismissed ? content : wall, data: { url: 'https://shop.example/' } };
      },
    });
    reg.register({
      name: 'tab.click',
      description: 'click an element',
      argsSchema: z.object({ tabId: z.number().int(), elementIndex: z.number().int() }),
      async dispatch() {
        dismissed = true;
        return { ok: true, content: 'Clicked' };
      },
    });
    return reg;
  }

  it('dismisses a consent wall on a click-only domain, then reads the real page', async () => {
    const wall = `   heading "We value your privacy"\n   text "We use cookies."\n[1] button "Accept all"\n[2] button "Reject all"`;
    const content = `   heading "Quiet Keyboard"\n   text "Price: £42.00 MARKER_CONTENT in stock"`;
    const events: TimelineEvent[] = [];
    const execPrompts: string[] = [];
    const ollama = makeFakeOllama(
      {
        planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'open and report', successCriteria: 'done' }] }) })],
        executor: [
          rawResponse({ toolCalls: [{ name: 'tab.open', args: { url: 'https://shop.example/' } }] }),
          rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'Price £42.00' } }] }),
        ],
        evaluator: [],
      },
      { onChat: (_m, role, messages) => { if (role === 'executor') execPrompts.push(JSON.stringify(messages)); } },
    );
    const orch = new Orchestrator({
      ollama,
      registry: consentReg(wall, content),
      settings: { ...DEFAULT_SETTINGS, domainTiers: { 'shop.example': 'click-only' } },
      emit: (e) => events.push(e),
    });
    const result = await orch.runUntilTerminal(await orch.start('open shop.example and report the price'));
    expect(result.phase).toBe('DONE');
    expect(events.some((e) => e.kind === 'log' && /dismissed consent/i.test(e.message))).toBe(true);
    // the real page (post-dismiss re-read) reached a later executor turn as CURRENT PAGE CONTENT
    expect(execPrompts.slice(1).join('\n')).toContain('MARKER_CONTENT');
  });

  it('does NOT dismiss on a read-only domain (acts only where authorized)', async () => {
    const wall = `   heading "We value your privacy"\n   text "We use cookies."\n[1] button "Reject all"`;
    const content = `   text "real content MARKER2"`;
    const events: TimelineEvent[] = [];
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'open and report', successCriteria: 'done' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'tab.open', args: { url: 'https://shop.example/' } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'blocked', summary: 'A cookie consent wall blocked the page.' } }] }),
      ],
      evaluator: [],
    });
    const orch = new Orchestrator({
      ollama,
      registry: consentReg(wall, content),
      settings: { ...DEFAULT_SETTINGS, domainTiers: {} }, // read-only
      emit: (e) => events.push(e),
    });
    await orch.runUntilTerminal(await orch.start('open shop.example and report'));
    expect(events.some((e) => e.kind === 'log' && /dismissed consent/i.test(e.message))).toBe(false);
  });
});

describe('orchestrator — RunResult.turns reflects the real turn count', () => {
  it('reports more than the 5-entry recent-actions window on a long run', async () => {
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'loop a bit', successCriteria: 'done' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'noop', args: { note: '1' } }] }),
        rawResponse({ toolCalls: [{ name: 'noop', args: { note: '2' } }] }),
        rawResponse({ toolCalls: [{ name: 'noop', args: { note: '3' } }] }),
        rawResponse({ toolCalls: [{ name: 'noop', args: { note: '4' } }] }),
        rawResponse({ toolCalls: [{ name: 'noop', args: { note: '5' } }] }),
        rawResponse({ toolCalls: [{ name: 'noop', args: { note: '6' } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'done' } }] }),
      ],
      evaluator: [],
    });
    const orch = new Orchestrator({ ollama, registry: buildRegistry(), settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const result = await orch.runUntilTerminal(await orch.start('long task'));
    expect(result.phase).toBe('DONE');
    expect(result.turns).toBeGreaterThanOrEqual(6);
  });
});

describe('orchestrator — fatal tool results terminate promptly', () => {
  it('ends "blocked" after repeated fatal tool errors instead of burning turns', async () => {
    const reg = buildRegistry();
    reg.register({
      name: 'fail',
      description: 'always fatally fails',
      argsSchema: z.object({ n: z.number().int().optional() }),
      async dispatch() {
        return { ok: false, fatal: true, content: 'Cannot act: read-only domain' };
      },
    });
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'try', successCriteria: 'x' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'fail', args: { n: 1 } }] }),
        rawResponse({ toolCalls: [{ name: 'fail', args: { n: 2 } }] }),
        rawResponse({ toolCalls: [{ name: 'fail', args: { n: 3 } }] }),
      ],
      evaluator: [],
    });
    const orch = new Orchestrator({ ollama, registry: reg, settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const result = await orch.runUntilTerminal(await orch.start('do the blocked thing'));
    expect(result.verdict).toBe('blocked');
  });
});

describe('orchestrator — timeline tool.result content is capped', () => {
  it('does not emit a huge page read verbatim into the timeline', async () => {
    const reg = buildRegistry();
    reg.register({
      name: 'aria.extract',
      description: 'extract',
      argsSchema: z.object({ tabId: z.number().int().optional() }),
      async dispatch() {
        return { ok: true, content: 'X'.repeat(5000), data: { url: 'https://x/' } };
      },
    });
    const events: TimelineEvent[] = [];
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'read and report', successCriteria: 'done' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'done' } }] }),
      ],
      evaluator: [],
    });
    const orch = new Orchestrator({ ollama, registry: reg, settings: { ...DEFAULT_SETTINGS }, emit: (e) => events.push(e) });
    await orch.runUntilTerminal(await orch.start('read the page'));
    const res = events.find((e) => e.kind === 'tool.result' && e.tool === 'aria.extract') as
      | Extract<TimelineEvent, { kind: 'tool.result' }>
      | undefined;
    expect(res).toBeTruthy();
    expect(res!.content.length).toBeLessThanOrEqual(2_100);
  });
});

describe('orchestrator — evaluator-issued finish is grounding-gated too', () => {
  // The executor's own finish tool is grounding-gated, but the EVALUATOR (same small-model
  // class) can also end the task via finishVerdict:'success' + finishSummary. Those numbers
  // must pass the same deterministic grounding check, or the evaluator becomes a hole that
  // finishes 'success' on a fabricated figure (and auto-records a poisoned recipe).
  function pageReg(content: string) {
    const reg = buildRegistry();
    reg.register({
      name: 'aria.extract',
      description: 'extract the page',
      argsSchema: z.object({ tabId: z.number().int().optional() }),
      async dispatch() {
        return { ok: true, content, data: { url: 'https://x/' } };
      },
    });
    return reg;
  }

  it('downgrades an evaluator success to partial when its summary asserts an ungrounded number', async () => {
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'read and report', successCriteria: 'done' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }),
        rawResponse({ toolCalls: [{ name: 'next_step', args: { reason: 'page read' } }] }),
      ],
      evaluator: [
        rawResponse({ content: JSON.stringify({ verdict: 'PASS', reason: 'done', shouldReplan: false, finishVerdict: 'success', finishSummary: 'The price is £99.99' }) }),
      ],
    });
    const orch = new Orchestrator({ ollama, registry: pageReg('Widget — in stock, no price shown'), settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const result = await orch.runUntilTerminal(await orch.start('report the price'));
    expect(result.verdict).toBe('partial');
    expect(result.summary).toContain('unverified against page');
  });

  it('accepts an evaluator success whose numbers are all grounded', async () => {
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'read and report', successCriteria: 'done' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }),
        rawResponse({ toolCalls: [{ name: 'next_step', args: { reason: 'page read' } }] }),
      ],
      evaluator: [
        rawResponse({ content: JSON.stringify({ verdict: 'PASS', reason: 'done', shouldReplan: false, finishVerdict: 'success', finishSummary: 'The price is £99.99' }) }),
      ],
    });
    const orch = new Orchestrator({ ollama, registry: pageReg('Widget price £99.99 in stock'), settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const result = await orch.runUntilTerminal(await orch.start('report the price'));
    expect(result.verdict).toBe('success');
  });

  it('passes an evaluator "blocked" finish through unchanged (honest failure, no grounding needed)', async () => {
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'read and report', successCriteria: 'done' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }),
        rawResponse({ toolCalls: [{ name: 'next_step', args: { reason: 'page read' } }] }),
      ],
      evaluator: [
        rawResponse({ content: JSON.stringify({ verdict: 'FAIL', reason: 'blocked', shouldReplan: false, finishVerdict: 'blocked', finishSummary: 'The page was behind a paywall.' }) }),
      ],
    });
    const orch = new Orchestrator({ ollama, registry: pageReg('Subscribe to read'), settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const result = await orch.runUntilTerminal(await orch.start('report the price'));
    expect(result.verdict).toBe('blocked');
  });
});

describe('orchestrator — finish robustness (terminal answer, partial grounding, counters)', () => {
  function pageReg(content: string) {
    const reg = buildRegistry();
    reg.register({
      name: 'aria.extract',
      description: 'extract the page',
      argsSchema: z.object({ tabId: z.number().int().optional() }),
      async dispatch() {
        return { ok: true, content, data: { url: 'https://x/' } };
      },
    });
    return reg;
  }

  // EX-1: a prose answer on the FINAL step is the deliverable — it must not be discarded
  // for a generic "Plan complete." (the small model often writes prose instead of finish()).
  it('uses the executor prose answer as the summary on the terminal step, not "Plan complete."', async () => {
    const prose = 'Based on the page I read, the Quiet Keyboard is currently priced at £42.00 and it is in stock right now.';
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'read and report the price', successCriteria: 'reported' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }),
        rawResponse({ content: prose }), // first call: no tool → triggers the retry
        rawResponse({ content: prose }), // retry: still no tool → prose-answer path (advanceStep)
      ],
      evaluator: [
        rawResponse({ content: JSON.stringify({ verdict: 'PASS', reason: 'reported', shouldReplan: false, finishVerdict: null, finishSummary: null }) }),
      ],
    });
    const orch = new Orchestrator({ ollama, registry: pageReg('Quiet Keyboard price £42.00 in stock'), settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const result = await orch.runUntilTerminal(await orch.start('report the price'));
    expect(result.summary).toContain('42.00');
    expect(result.summary).not.toBe('Plan complete.');
    expect(result.verdict).toBe('success');
  });

  // EX-2: a 'partial' answer carries data too — an ungrounded number in it must be flagged,
  // not passed through verbatim (only 'blocked'/'failed' are fabrication-free honest outcomes).
  it('flags an ungrounded number in a partial finish', async () => {
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'read and report', successCriteria: 'done' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'partial', summary: 'Found the item; the price appears to be £99.99' } }] }),
      ],
      evaluator: [],
    });
    const orch = new Orchestrator({ ollama, registry: pageReg('Widget — in stock, no price shown'), settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const result = await orch.runUntilTerminal(await orch.start('report the price'));
    expect(result.verdict).toBe('partial');
    expect(result.summary).toContain('unverified against page');
  });

  // EX-3: an empty/whitespace success summary is not a real answer — it must not finish 'success'.
  it('does not accept a success finish with an empty summary', async () => {
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'read and report', successCriteria: 'done' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: '   ' } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: '' } }] }),
      ],
      evaluator: [],
    });
    const orch = new Orchestrator({ ollama, registry: pageReg('Widget price £42.00'), settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const result = await orch.runUntilTerminal(await orch.start('report the price'));
    expect(result.verdict).toBe('partial');
    expect(result.summary).toContain('no answer text');
  });

  // ST-M2: the finish-retry budget (verifyAttempts) must reset when the plan advances, or a
  // later step's first ungrounded finish is wrongly treated as its last attempt → forced partial.
  it('resets the finish-retry budget when the plan advances to a new step', async () => {
    const reg = buildRegistry();
    let reads = 0;
    reg.register({
      name: 'aria.extract',
      description: 'extract',
      argsSchema: z.object({ tabId: z.number().int().optional() }),
      async dispatch() {
        reads += 1;
        return { ok: true, content: reads <= 1 ? 'Item A price £10.00' : 'Item B price £20.00', data: { url: 'https://x/' } };
      },
    });
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [
        { description: 'find A', successCriteria: 'a' },
        { description: 'find B and report', successCriteria: 'b' },
      ] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }),                            // step1 read (A £10)
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'A is £99.99' } }] }), // step1 ungrounded → rejected (attempt 1)
        rawResponse({ toolCalls: [{ name: 'next_step', args: { reason: 'found A' } }] }),                       // advance → reset budget
        rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }),                            // step2 read (B £20)
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'B is £88.88' } }] }), // step2 ungrounded → with reset: attempt 1 (corrective); without: attempt 2 (forced partial)
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'B is £20.00' } }] }), // step2 grounded → success
      ],
      evaluator: [
        rawResponse({ content: JSON.stringify({ verdict: 'PASS', reason: 'found A', shouldReplan: false, finishVerdict: null, finishSummary: null }) }),
      ],
    });
    const orch = new Orchestrator({ ollama, registry: reg, settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const result = await orch.runUntilTerminal(await orch.start('compare A and B'));
    expect(result.verdict).toBe('success');
    expect(result.summary).toContain('20.00');
  });

  // ST-M3: consecutiveFatal must reset when the plan advances — a successful step between two
  // fatals means they are NOT consecutive and must not trip the "blocked" termination.
  it('resets the consecutive-fatal counter when the plan advances (non-consecutive fatals do not block)', async () => {
    const reg = buildRegistry();
    reg.register({
      name: 'aria.extract',
      description: 'extract',
      argsSchema: z.object({ tabId: z.number().int().optional() }),
      async dispatch() {
        return { ok: true, content: 'Item price £15.00', data: { url: 'https://x/' } };
      },
    });
    reg.register({
      name: 'fail',
      description: 'fatal',
      argsSchema: z.object({ n: z.number().int().optional() }),
      async dispatch() {
        return { ok: false, fatal: true, content: 'Cannot act: read-only domain' };
      },
    });
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [
        { description: 'step one', successCriteria: 'a' },
        { description: 'step two and report', successCriteria: 'b' },
      ] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'fail', args: { n: 1 } }] }),                                         // step1 fatal (count=1)
        rawResponse({ toolCalls: [{ name: 'next_step', args: { reason: 'moving on' } }] }),                     // advance → reset count
        rawResponse({ toolCalls: [{ name: 'fail', args: { n: 2 } }] }),                                         // step2 fatal (count=1 w/ reset; =2 without → blocked)
        rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }),                            // step2 read
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'The price is £15.00' } }] }),
      ],
      evaluator: [
        rawResponse({ content: JSON.stringify({ verdict: 'PASS', reason: 'moving on', shouldReplan: false, finishVerdict: null, finishSummary: null }) }),
      ],
    });
    const orch = new Orchestrator({ ollama, registry: reg, settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const result = await orch.runUntilTerminal(await orch.start('do two steps'));
    expect(result.verdict).toBe('success');
  });
});

describe('orchestrator — PII in tool args is redacted (job-apply privacy)', () => {
  it('does not leak a typed email into the scratchpad / later prompts', async () => {
    const reg = buildRegistry();
    reg.register({
      name: 'tab.type',
      description: 'type into a field',
      argsSchema: z.object({ tabId: z.number().int(), elementIndex: z.number().int(), text: z.string() }),
      async dispatch() {
        return { ok: true, content: 'Typed' };
      },
    });
    const execPrompts: string[] = [];
    const ollama = makeFakeOllama(
      {
        planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'fill the form', successCriteria: 'done' }] }) })],
        executor: [
          rawResponse({ toolCalls: [{ name: 'tab.type', args: { tabId: 1, elementIndex: 2, text: 'john.doe@example.com' } }] }),
          rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'Filled the email field.' } }] }),
        ],
        evaluator: [],
      },
      { onChat: (_m, role, messages) => { if (role === 'executor') execPrompts.push(JSON.stringify(messages)); } },
    );
    const orch = new Orchestrator({ ollama, registry: reg, settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const result = await orch.runUntilTerminal(await orch.start('fill in my email on the form'));
    expect(result.phase).toBe('DONE');
    // Turn 2's prompt carries turn 1's action via BOTH the scratchpad turn-note and the
    // recentActions block — neither may carry the raw email (args were previously un-redacted).
    expect(execPrompts.length).toBeGreaterThanOrEqual(2);
    expect(execPrompts.slice(1).join('\n')).not.toContain('john.doe@example.com');
  });
});

describe('orchestrator — ask-page fast path (seeded plan skips the planner + cites the source)', () => {
  it('answers from the current page without ever calling the planner, and surfaces the source URL', async () => {
    let plannerCalls = 0;
    const reg = buildRegistry();
    reg.register({
      name: 'tab.read_active',
      description: 'read the active tab',
      argsSchema: z.object({ reason: z.string().optional() }),
      async dispatch() {
        return { ok: true, content: 'Quiet Keyboard — Price £42.00, in stock.', data: { url: 'https://shop.example/p', tabId: 9 } };
      },
    });
    const events: TimelineEvent[] = [];
    const ollama = makeFakeOllama(
      {
        planner: [], // intentionally empty — if the planner runs, plannerCalls catches it
        executor: [
          rawResponse({ toolCalls: [{ name: 'tab.read_active', args: {} }] }),
          rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'The price on this page is £42.00.' } }] }),
        ],
        evaluator: [],
      },
      { onChat: (_m, role) => { if (role === 'planner') plannerCalls++; } },
    );
    const orch = new Orchestrator({
      ollama,
      registry: reg,
      settings: { ...DEFAULT_SETTINGS },
      emit: (e) => events.push(e),
      seedPlan: [{ description: 'Read the current page and answer the question', successCriteria: 'answered', toolHint: 'tab.read_active' }],
    });
    const result = await orch.runUntilTerminal(await orch.start('what is the price on this page?'));

    expect(result.verdict).toBe('success');
    expect(result.summary).toContain('42.00');
    expect(plannerCalls).toBe(0); // the planner — our slowest call — was skipped
    const fin = events.find((e) => e.kind === 'finish') as Extract<TimelineEvent, { kind: 'finish' }>;
    expect(fin.sources).toContain('https://shop.example/p'); // citation surfaced
  });
});

describe('orchestrator — salvages an answer from what it read instead of giving up empty', () => {
  it('on a give-up (max replans), synthesizes a grounded partial answer from everything observed', async () => {
    const reg = buildRegistry();
    reg.register({
      name: 'aria.extract',
      description: 'read',
      argsSchema: z.object({ tabId: z.number().int().optional() }),
      async dispatch() {
        return {
          ok: true,
          content: 'Austin population 975000. Seattle population 785000. Denver population 716000.',
          data: { url: 'https://en.wikipedia.org/wiki/Austin,_Texas' },
        };
      },
    });
    // Read the data once, then repeat a no-op until the action-repeat breaker trips → with
    // maxReplans:1 that's an immediate give-up. The data is already in observedText by then.
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'gather and compare', successCriteria: 'done' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }),
        rawResponse({ toolCalls: [{ name: 'noop', args: { note: 'x' } }] }),
        rawResponse({ toolCalls: [{ name: 'noop', args: { note: 'x' } }] }),
        rawResponse({ toolCalls: [{ name: 'noop', args: { note: 'x' } }] }),
      ],
      evaluator: [],
      // The final synthesis call (a non-role prompt → 'unknown') answers from the gathered notes.
      unknown: [rawResponse({ content: 'Austin has the largest population at 975000, ahead of Seattle (785000) and Denver (716000).' })],
    });
    const orch = new Orchestrator({
      ollama,
      registry: reg,
      settings: { ...DEFAULT_SETTINGS },
      emit: () => undefined,
      maxReplans: 1,
      maxStepTurns: 8,
    });
    const result = await orch.runUntilTerminal(await orch.start('compare Austin, Seattle, Denver populations'));

    expect(result.verdict).toBe('partial'); // salvaged — NOT 'aborted' with no answer
    expect(result.summary).toContain('Austin');
    expect(result.summary).toContain('975000');
  });
});

describe('orchestrator — re-answers from the full corpus when a finish reports a field as missing', () => {
  // Live failure (British Museum facilities): the answer was in the step-1 search snippets / an
  // earlier page read (→ observedText), but the agent over-navigated into a narrow sub-page and
  // finished "Café: not listed. Wi-Fi: not listed." A finish that claims a requested field is
  // MISSING must be reconciled against everything gathered before it stands.
  it('replaces a "not listed" finish with a corpus answer that fills the gap', async () => {
    const reg = buildRegistry();
    reg.register({
      name: 'aria.extract',
      description: 'read',
      argsSchema: z.object({ tabId: z.number().int().optional() }),
      async dispatch() {
        return {
          ok: true,
          content:
            'British Museum facilities: Court Café open daily. Cloakroom available for bags and coats. Free Wi-Fi throughout the building.',
          data: { url: 'https://www.britishmuseum.org/visit' },
        };
      },
    });
    const ollama = makeFakeOllama({
      planner: [
        rawResponse({
          content: JSON.stringify({
            steps: [
              { description: 'open the official site and read facilities', successCriteria: 'facilities read' },
              { description: 'report the facilities', successCriteria: 'reported' },
            ],
          }),
        }),
      ],
      executor: [
        rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'Cloakroom: available. Café: not listed. Wi-Fi: not listed.' } }] }),
      ],
      evaluator: [],
      // The corpus re-answer (a non-role prompt → 'unknown') fills the gap from observedText.
      unknown: [rawResponse({ content: 'The British Museum lists a Court Café (open daily), a cloakroom for bags and coats, and free Wi-Fi throughout.' })],
    });
    const orch = new Orchestrator({
      ollama,
      registry: reg,
      settings: { ...DEFAULT_SETTINGS },
      emit: () => undefined,
      maxStepTurns: 8,
    });
    const result = await orch.runUntilTerminal(
      await orch.start('what facilities does the British Museum list — cloakroom, café, Wi-Fi?'),
    );
    expect(result.summary.toLowerCase()).not.toContain('not listed');
    expect(result.summary).toContain('Wi-Fi');
    expect(result.summary).toContain('Café');
  });

  it('leaves a clean positive finish untouched (no corpus re-answer when nothing is reported missing)', async () => {
    const reg = buildRegistry();
    let unknownCalls = 0;
    const ollama = makeFakeOllama(
      {
        planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'answer', successCriteria: 'done' }] }) })],
        executor: [rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'The café is open daily and Wi-Fi is free.' } }] })],
        evaluator: [],
      },
      { onChat: (_m, role) => { if (role === 'unknown') unknownCalls++; } },
    );
    const orch = new Orchestrator({ ollama, registry: reg, settings: { ...DEFAULT_SETTINGS }, emit: () => undefined, maxStepTurns: 8 });
    const result = await orch.runUntilTerminal(await orch.start('is the café open and is there Wi-Fi?'));
    expect(result.summary).toBe('The café is open daily and Wi-Fi is free.');
    expect(unknownCalls).toBe(0); // no missing-claim → no corpus re-answer call
  });

  it('keeps the honest "not shown" when the corpus genuinely lacks the field (no fabrication)', async () => {
    const reg = buildRegistry();
    reg.register({
      name: 'aria.extract',
      description: 'read',
      argsSchema: z.object({ tabId: z.number().int().optional() }),
      async dispatch() {
        return { ok: true, content: 'Product: Quiet Keyboard. Price: £29.99. In stock.', data: { url: 'https://shop.example/p/1' } };
      },
    });
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'read the product', successCriteria: 'read' }, { description: 'report', successCriteria: 'reported' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'Price: £29.99. Star rating: not shown on the page.' } }] }),
      ],
      evaluator: [],
      // The corpus genuinely has no rating, so the re-answer also can't supply one (still reports it missing).
      unknown: [rawResponse({ content: 'The price is £29.99 and it is in stock; the star rating is not shown on the page.' })],
    });
    const orch = new Orchestrator({ ollama, registry: reg, settings: { ...DEFAULT_SETTINGS }, emit: () => undefined, maxStepTurns: 8 });
    const result = await orch.runUntilTerminal(await orch.start('what is the price and star rating of the Quiet Keyboard?'));
    // Honest gap preserved — must NOT fabricate a rating, and the corpus re-answer (which also lacks it) is not adopted blindly.
    expect(result.summary.toLowerCase()).toContain('not shown');
    expect(result.summary).toContain('29.99');
  });
});

describe('orchestrator — user recipe trust/quarantine (the authored-recipe safety net)', () => {
  const userRecipe = (over: Partial<Workflow> = {}): Workflow => ({
    id: 'user:r1', origin: 'user', domain: '*', goalKeywords: ['knit', 'scarf'], goalSample: 'knit a scarf',
    whenToUse: 'knit a scarf', steps: [{ instruction: 'step one' }, { instruction: 'step two' }], trusted: false, ...over,
  });
  const isTrusted = async () => (await loadWorkflows()).find((w) => w.id === 'user:r1')?.trusted;
  const exists = async () => (await loadWorkflows()).some((w) => w.id === 'user:r1');

  it('does NOT auto-record a duplicate when a recipe already drove the run (user recipe survives + editable)', async () => {
    await upsertUserWorkflow(userRecipe());
    const reg = buildRegistry();
    reg.register({
      name: 'search',
      description: 'web search',
      argsSchema: z.object({ query: z.string() }),
      async dispatch() {
        return { ok: true, content: '1. how to knit a scarf, beginner guide', data: { results: [{ url: 'https://x/' }] } };
      },
    });
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'do it', successCriteria: 'done' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'search', args: { query: 'knit a scarf' } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'Cast on, knit rows, bind off.' } }] }),
      ],
      evaluator: [],
    });
    const orch = new Orchestrator({ ollama, registry: reg, settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    await orch.runUntilTerminal(await orch.start('knit a scarf for me'));
    const all = await loadWorkflows();
    expect(all.filter((w) => w.id.startsWith('auto:')).length).toBe(0); // no auto duplicate created
    const u = all.find((w) => w.id === 'user:r1')!;
    expect(u.origin).toBe('user'); // survived as a user recipe (still editable), not clobbered into auto
    expect(u.trusted).toBe(true); // and was confirmed by the clean run
  });

  it('a clean success CONFIRMS (trusts) the user recipe that drove it', async () => {
    await upsertUserWorkflow(userRecipe());
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'do it', successCriteria: 'done' }] }) })],
      executor: [rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'knitted' } }] })],
      evaluator: [],
    });
    const orch = new Orchestrator({ ollama, registry: buildRegistry(), settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const r = await orch.runUntilTerminal(await orch.start('knit a scarf for me'));
    expect(r.verdict).toBe('success');
    expect(await isTrusted()).toBe(true); // proven by a clean run
  });

  it('a failed run DELETES a brand-new (unproven) user recipe that drove it', async () => {
    await upsertUserWorkflow(userRecipe());
    // multi-step plan (no thin-plan retry); executor never calls a tool → unknown-tool storm → ABORTED
    const multiStep = rawResponse({ content: JSON.stringify({ steps: [{ description: 'a', successCriteria: 'x' }, { description: 'b', successCriteria: 'y' }] }) });
    const ollama = makeFakeOllama({
      planner: [multiStep, multiStep, multiStep],
      executor: [
        rawResponse({ content: 'no tool' }), rawResponse({ content: 'still none' }),
        rawResponse({ content: 'a' }), rawResponse({ content: 'b' }), rawResponse({ content: 'c' }), rawResponse({ content: 'd' }),
      ],
      evaluator: [],
    });
    const orch = new Orchestrator({ ollama, registry: buildRegistry(), settings: { ...DEFAULT_SETTINGS }, emit: () => undefined, maxReplans: 2, maxStepTurns: 4 });
    const r = await orch.runUntilTerminal(await orch.start('knit a scarf for me'));
    expect(r.phase).toBe('ABORTED');
    expect(await exists()).toBe(false); // unproven + failed → removed
  });

  it('a failed run ROLLS BACK an edited (trusted→edited) user recipe to its last-good version', async () => {
    // proven v1, then a bad edit (untrusted, has lastGood)
    await upsertUserWorkflow(userRecipe());
    await markWorkflowTrusted('user:r1');
    await upsertUserWorkflow(userRecipe({ steps: [{ instruction: 'step one' }, { instruction: 'bad edit' }] }));
    const multiStep = rawResponse({ content: JSON.stringify({ steps: [{ description: 'a', successCriteria: 'x' }, { description: 'b', successCriteria: 'y' }] }) });
    const ollama = makeFakeOllama({
      planner: [multiStep, multiStep, multiStep],
      executor: [
        rawResponse({ content: 'no tool' }), rawResponse({ content: 'still none' }),
        rawResponse({ content: 'a' }), rawResponse({ content: 'b' }), rawResponse({ content: 'c' }), rawResponse({ content: 'd' }),
      ],
      evaluator: [],
    });
    const orch = new Orchestrator({ ollama, registry: buildRegistry(), settings: { ...DEFAULT_SETTINGS }, emit: () => undefined, maxReplans: 2, maxStepTurns: 4 });
    await orch.runUntilTerminal(await orch.start('knit a scarf for me'));
    const wf = (await loadWorkflows()).find((w) => w.id === 'user:r1')!;
    expect(wf.steps.map((s) => s.instruction)).toEqual(['step one', 'step two']); // rolled back
    expect(wf.trusted).toBe(true);
  });
});

describe('orchestrator — clean-run recipe gate (only a frictionless success is taught back)', () => {
  const seedCount = async () => (await loadWorkflows()).length;
  // A navigational run (search → open_result → finish) is "worth learning"; pure search→report isn't.
  const withSearch = () => {
    const reg = buildRegistry();
    reg.register({
      name: 'search',
      description: 'web search',
      argsSchema: z.object({ query: z.string() }),
      async dispatch() {
        return { ok: true, content: '1. Austin — pop 961,855', data: { results: [{ url: 'https://x/' }] } };
      },
    });
    reg.register({
      name: 'open_result',
      description: 'open a result',
      argsSchema: z.object({ index: z.number().int() }),
      async dispatch() {
        return { ok: true, content: 'opened', data: { tabId: 5, url: 'https://x/' } };
      },
    });
    return reg;
  };

  it('saves a recipe from a CLEAN success (no friction)', async () => {
    const before = await seedCount();
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'find it and report', successCriteria: 'done' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'search', args: { query: 'Austin population' } }] }),
        rawResponse({ toolCalls: [{ name: 'open_result', args: { index: 1 } }] }), // navigated → worth learning
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'Austin 961,855' } }] }),
      ],
      evaluator: [],
    });
    const orch = new Orchestrator({ ollama, registry: withSearch(), settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const r = await orch.runUntilTerminal(await orch.start('do a clean thing'));
    expect(r.verdict).toBe('success');
    expect(await seedCount()).toBe(before + 1); // a clean, navigational run is recorded
  });

  it('does NOT learn a recipe from a trivial search-and-report lookup (no navigation)', async () => {
    const before = await seedCount();
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'find it', successCriteria: 'done' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'search', args: { query: 'capital of australia' } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'Canberra' } }] }),
      ],
      evaluator: [],
    });
    const orch = new Orchestrator({ ollama, registry: withSearch(), settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const r = await orch.runUntilTerminal(await orch.start('Find the capital city of Australia'));
    expect(r.verdict).toBe('success'); // still answers correctly
    expect(await seedCount()).toBe(before); // …but a trivial lookup teaches nothing
  });

  it('does NOT save a recipe from a MESSY success (a tier denial happened en route)', async () => {
    const before = await seedCount();
    const reg = withSearch();
    reg.register({
      name: 'act',
      description: 'a tier-gated action that is denied',
      argsSchema: z.object({ n: z.number().int().optional() }),
      async dispatch() {
        return { ok: false, fatal: true, content: 'Cannot click-only on en.wikipedia.org (current tier: read-only).' };
      },
    });
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'find it and report', successCriteria: 'done' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'search', args: { query: 'Austin population' } }] }),
        rawResponse({ toolCalls: [{ name: 'act', args: { n: 1 } }] }), // tier denial → run is dirty
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'Austin 961,855 anyway' } }] }),
      ],
      evaluator: [],
    });
    const orch = new Orchestrator({ ollama, registry: reg, settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const r = await orch.runUntilTerminal(await orch.start('do a messy thing'));
    expect(r.verdict).toBe('success'); // still answers
    expect(await seedCount()).toBe(before); // …but the messy path is NOT taught back
  });
});

describe('orchestrator — steer: a mid-run user correction reaches later turns as guidance', () => {
  it('a steer issued during the run surfaces as USER GUIDANCE on a subsequent executor turn', async () => {
    const execPrompts: string[] = [];
    let orchRef: Orchestrator | null = null;
    let steered = false;
    const ollama = makeFakeOllama(
      {
        planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'loop then finish', successCriteria: 'done' }] }) })],
        executor: [
          rawResponse({ toolCalls: [{ name: 'noop', args: { note: '1' } }] }),
          rawResponse({ toolCalls: [{ name: 'noop', args: { note: '2' } }] }),
          rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'done' } }] }),
        ],
        evaluator: [],
      },
      {
        onChat: (_m, role, messages) => {
          if (role !== 'executor') return;
          execPrompts.push(JSON.stringify(messages));
          if (!steered) {
            steered = true;
            orchRef?.steer('search each city separately'); // inject mid-run, after turn 1's call
          }
        },
      },
    );
    const orch = new Orchestrator({ ollama, registry: buildRegistry(), settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    orchRef = orch;
    const result = await orch.runUntilTerminal(await orch.start('do the thing'));

    expect(result.phase).toBe('DONE');
    expect(execPrompts.length).toBeGreaterThanOrEqual(2);
    expect(execPrompts[0]).not.toContain('search each city separately'); // not yet applied on turn 1
    const later = execPrompts.slice(1).join('\n');
    expect(later).toContain('search each city separately'); // injected guidance reached a later turn
    expect(later).toMatch(/USER GUIDANCE/);
  });
});

describe('orchestrator — salvages a grounded answer when it gives up AFTER an action denial', () => {
  // Live failure: the agent read each city's population from search snippets (→ observedText),
  // then hit read-only click denials, then conceded with "I was unable to extract … read-only
  // constraints." The facts were ALREADY gathered — that defeatist exit must be salvaged.
  function regWithDataAndDenial() {
    const reg = buildRegistry();
    reg.register({
      name: 'aria.extract',
      description: 'read',
      argsSchema: z.object({ tabId: z.number().int().optional() }),
      async dispatch() {
        return {
          ok: true,
          content: 'Austin population 961855. Seattle population 784777. Denver population 715522.',
          data: { url: 'https://en.wikipedia.org/wiki/Austin,_Texas' },
        };
      },
    });
    reg.register({
      name: 'act',
      description: 'a tier-gated action denied on a read-only page',
      argsSchema: z.object({ n: z.number().int().optional() }),
      async dispatch() {
        return { ok: false, fatal: true, content: 'Cannot click on en.wikipedia.org (current tier: read-only). Upgrade this domain in Settings.' };
      },
    });
    return reg;
  }

  it('overrides a voluntary blocked finish with a grounded partial salvaged from observedText', async () => {
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'gather and compare', successCriteria: 'done' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }), // 3 populations → observedText
        rawResponse({ toolCalls: [{ name: 'act', args: { n: 1 } }] }), // tier denial → sawActionDenial
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'blocked', summary: 'I was unable to extract the populations due to read-only constraints.' } }] }),
      ],
      evaluator: [],
      unknown: [rawResponse({ content: 'Austin has the largest population at 961855, ahead of Seattle (784777) and Denver (715522).' })],
    });
    const orch = new Orchestrator({ ollama, registry: regWithDataAndDenial(), settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const result = await orch.runUntilTerminal(await orch.start('compare Austin, Seattle, Denver populations using Wikipedia'));
    expect(result.verdict).toBe('partial'); // salvaged, not the defeatist 'blocked'
    expect(result.summary).toContain('961855');
    expect(result.summary).toContain('Austin');
    expect(result.summary).not.toMatch(/read-only constraints/i);
  });

  it('does NOT salvage an honest blocked finish when there was NO denial (genuine not-found stays blocked)', async () => {
    const reg = buildRegistry();
    reg.register({
      name: 'aria.extract',
      description: 'read',
      argsSchema: z.object({ tabId: z.number().int().optional() }),
      async dispatch() {
        return { ok: true, content: 'No results. We could not find any matches for your search.', data: { url: 'https://shop.example/s' } };
      },
    });
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'find it', successCriteria: 'done' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'blocked', summary: 'No matching product was found.' } }] }),
      ],
      evaluator: [],
      unknown: [rawResponse({ content: 'SHOULD NOT BE USED' })],
    });
    const orch = new Orchestrator({ ollama, registry: reg, settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const result = await orch.runUntilTerminal(await orch.start('find the blender'));
    expect(result.verdict).toBe('blocked'); // no denial → honest blocked preserved
    expect(result.summary).toContain('No matching product');
    expect(result.summary).not.toContain('SHOULD NOT BE USED');
  });
});

describe('orchestrator — facts ledger: retention across steps', () => {
  // Test A: Three steps, each reads a page with a distinct number.  The evaluator
  // returns a grounded `fact` per step.  We capture executor messages on the FINAL
  // turn and assert the FINDINGS: section carries all three facts, proving that early
  // ledger entries survive to the last turn.
  it('carries all grounded facts from earlier steps into the final executor turn FINDINGS block', async () => {
    // Three pages, each with a unique number that is also present in the evaluator's fact field.
    const pages = [
      { content: 'City 1 population: 111,111', url: 'https://cities.test/1', fact: 'City 1: 111,111' },
      { content: 'City 2 population: 222,222', url: 'https://cities.test/2', fact: 'City 2: 222,222' },
      { content: 'City 3 population: 333,333', url: 'https://cities.test/3', fact: 'City 3: 333,333' },
    ];
    let pageIdx = -1;

    const reg = buildRegistry();
    reg.register({
      name: 'aria.extract',
      description: 'extract the page',
      argsSchema: z.object({ tabId: z.number().int().optional() }),
      async dispatch() {
        pageIdx += 1;
        const p = pages[pageIdx] ?? pages[pages.length - 1];
        return { ok: true, content: p.content, data: { url: p.url } };
      },
    });

    const execPrompts: string[] = [];
    const ollama = makeFakeOllama(
      {
        planner: [
          rawResponse({
            content: JSON.stringify({
              steps: [
                { description: 'read city 1', successCriteria: 'got city 1 pop' },
                { description: 'read city 2', successCriteria: 'got city 2 pop' },
                { description: 'read city 3 and report', successCriteria: 'got city 3 pop' },
              ],
            }),
          }),
        ],
        executor: [
          // Step 1: read page 1, then advance
          rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }),
          rawResponse({ toolCalls: [{ name: 'next_step', args: { reason: 'got city 1' } }] }),
          // Step 2: read page 2, then advance
          rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }),
          rawResponse({ toolCalls: [{ name: 'next_step', args: { reason: 'got city 2' } }] }),
          // Step 3: read page 3, then finish
          rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }),
          rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'City 1: 111,111. City 2: 222,222. City 3: 333,333.' } }] }),
        ],
        evaluator: [
          // Evaluator for step 1 — fact grounded in "City 1 population: 111,111"
          rawResponse({
            content: JSON.stringify({
              verdict: 'PASS', reason: 'city 1 read', shouldReplan: false,
              finishVerdict: null, finishSummary: null,
              fact: 'City 1: 111,111',
            }),
          }),
          // Evaluator for step 2 — fact grounded in "City 2 population: 222,222"
          rawResponse({
            content: JSON.stringify({
              verdict: 'PASS', reason: 'city 2 read', shouldReplan: false,
              finishVerdict: null, finishSummary: null,
              fact: 'City 2: 222,222',
            }),
          }),
          // Step 3 finishes via executor finish tool — no evaluator needed
        ],
      },
      {
        onChat: (_m, role, messages) => {
          if (role === 'executor') execPrompts.push(JSON.stringify(messages));
        },
      },
    );

    const orch = new Orchestrator({
      ollama,
      registry: reg,
      settings: { ...DEFAULT_SETTINGS },
      emit: () => undefined,
    });

    const result = await orch.runUntilTerminal(await orch.start('compare city populations'));

    expect(result.phase).toBe('DONE');
    // The last executor turn is the one that calls finish — it must see all three facts.
    // We need at least 5 turns: extract1, next_step1, extract2, next_step2, extract3.
    expect(execPrompts.length).toBeGreaterThanOrEqual(5);
    const lastPrompt = execPrompts[execPrompts.length - 1];
    // All three facts must appear in the FINDINGS block of the final executor prompt.
    expect(lastPrompt).toContain('FINDINGS:');
    expect(lastPrompt).toContain('111,111');
    expect(lastPrompt).toContain('222,222');
    // City 3 is on the current page (not yet in the ledger when step 3's executor is called),
    // but 111,111 and 222,222 must have survived from steps 1 and 2.
    // NOTE: City 3's fact is added AFTER the evaluator runs for step 3, which only fires when
    // next_step is called — not when finish() is called — so 333,333 may not be in FINDINGS
    // on the final executor turn. The key assertion is that early facts survive.
  });
});

describe('orchestrator — facts ledger: ungrounded mid-plan prose is blocked', () => {
  // Test B: On a non-final step the executor returns prose (no tool call, both turns are
  // prose ≥ 80 chars) that asserts a number NOT present on any page read yet.  The
  // orchestrator must NOT advance the plan — instead it appends a [VERIFICATION] note
  // to the scratchpad and continues the same step.
  //
  // Positive sub-case: when the prose asserts the GROUNDED number (one present on the
  // page already read), the plan DOES advance — proving the gate is specific, not blanket.
  it('blocks a non-final prose answer that asserts an ungrounded number, advances when grounded', async () => {
    // Page content only has 111,111. The first prose attempt asserts 999,999 (not on the page).
    // The second attempt (after the [VERIFICATION] nudge) asserts 111,111 (grounded).
    const PAGE_CONTENT = 'City Alpha population: 111,111 residents';

    let ariaCalls = 0;
    const reg = buildRegistry();
    reg.register({
      name: 'aria.extract',
      description: 'extract the page',
      argsSchema: z.object({ tabId: z.number().int().optional() }),
      async dispatch() {
        ariaCalls += 1;
        return { ok: true, content: PAGE_CONTENT, data: { url: 'https://cities.test/alpha' } };
      },
    });

    // We need to observe the scratchpad to confirm the [VERIFICATION] note was written.
    // The harness exposes scratchpad contents via executor prompts (ctx.scratchpad is injected).
    // So we capture executor prompts to check both the blocked-step and the advance.
    const execPrompts: string[] = [];
    const ollama = makeFakeOllama(
      {
        planner: [
          rawResponse({
            content: JSON.stringify({
              steps: [
                { description: 'read city alpha and report pop', successCriteria: 'population reported' },
                { description: 'wrap up', successCriteria: 'done' },
              ],
            }),
          }),
        ],
        executor: [
          // Turn 1: read the page (aria.extract → records 111,111 in observedText)
          rawResponse({ toolCalls: [{ name: 'aria.extract', args: { tabId: 1 } }] }),
          // Turn 2: first prose attempt — asserts UNGROUNDED 999,999 (not on any page read)
          // Both turns must be prose to trigger the 'answer' path (first attempt + retry are both prose).
          rawResponse({ content: 'Based on my research the population of City Alpha is approximately 999,999 residents as reported in the latest census available.' }),
          rawResponse({ content: 'Based on my research the population of City Alpha is approximately 999,999 residents as reported in the latest census available.' }),
          // Turn 3: prose with GROUNDED 111,111 — should advance the step.
          rawResponse({ content: 'The population of City Alpha is 111,111 residents according to the page I just read. This is accurate per the aria.extract output I obtained.' }),
          rawResponse({ content: 'The population of City Alpha is 111,111 residents according to the page I just read. This is accurate per the aria.extract output I obtained.' }),
          // After advance: finish on step 2
          rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'City Alpha population: 111,111' } }] }),
        ],
        evaluator: [
          // Evaluator for step 1 after the grounded prose advances it
          rawResponse({
            content: JSON.stringify({
              verdict: 'PASS', reason: 'population reported', shouldReplan: false,
              finishVerdict: null, finishSummary: null, fact: null,
            }),
          }),
        ],
      },
      {
        onChat: (_m, role, messages) => {
          if (role === 'executor') execPrompts.push(JSON.stringify(messages));
        },
      },
    );

    const orch = new Orchestrator({
      ollama,
      registry: reg,
      settings: { ...DEFAULT_SETTINGS },
      emit: () => undefined,
    });

    const result = await orch.runUntilTerminal(await orch.start('find city alpha population'));

    expect(result.phase).toBe('DONE');
    // The plan completed, proving the grounded prose did advance the step.
    expect(result.verdict).toBe('success');

    // The [VERIFICATION] note must have been written to the scratchpad after the ungrounded
    // prose was blocked.  It then appears in subsequent executor prompts (ctx.scratchpad).
    // Turn indices: 0=aria.extract, 1=first-ungrounded-prose, 2=second-grounded-prose, 3=finish-step2.
    // The scratchpad is injected into ctx on every executor call, so look at prompts after turn 1.
    const promptsAfterBlock = execPrompts.slice(2).join('\n');
    expect(promptsAfterBlock).toContain('[VERIFICATION]');
    // Also confirm the grounded answer did advance (final verdict 'success', not 'partial' or 'aborted').
    expect(result.summary).toContain('111,111');
  });
});
