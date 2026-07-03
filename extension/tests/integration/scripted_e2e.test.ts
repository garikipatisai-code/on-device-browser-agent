// Deterministic end-to-end: the REAL orchestrator + the REAL core tools + the bench's
// ScriptedBrowser tool surface, driven by a FAKE model. The live bench (run.bench.test.ts)
// exercises this exact wiring but only with a real Ollama; this version locks the full path
// — navigating tool → auto-observe re-read → observedText grounding → finish gate → scorer —
// under deterministic control, so an orchestrator↔tools wiring regression is caught in `npm test`.

import { beforeEach, describe, expect, it } from 'vitest';
import { Orchestrator } from '@/agent/orchestrator';
import { DEFAULT_SETTINGS } from '@/shared/messages';
import { clearHot } from '@/background/state_store';
import { makeFakeOllama, rawResponse, resetStorage } from '../helpers';
import { BENCH_TASKS, type BenchTask } from '../bench/fixtures';
import { ScriptedBrowser, buildScriptedRegistry } from '../bench/scripted_browser';
import { scoreRun, type BenchRun } from '../bench/scorer';

beforeEach(async () => {
  await resetStorage();
  await clearHot();
});

function task(id: string): BenchTask {
  const t = BENCH_TASKS.find((x) => x.id === id);
  if (!t) throw new Error(`fixture ${id} not found`);
  return t;
}

describe('scripted-browser E2E (real orchestrator + real tools + fake model)', () => {
  it('sale-price: open → auto-read → click → auto-read → grounded finish scores correct+grounded', async () => {
    const t = task('sale-price');
    const state = new ScriptedBrowser(t);
    const registry = buildScriptedRegistry(state);
    // tab.open and tab.click each trigger the orchestrator's auto-observe (aria.extract), so the
    // executor never has to read explicitly — it opens, clicks the product, then reports.
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'open the Studio Wireless Headphones product and report its current price', successCriteria: 'current price reported' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'tab.open', args: { url: 'https://shop.example/' } }] }),
        rawResponse({ toolCalls: [{ name: 'tab.click', args: { tabId: 101, elementIndex: 1 } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'The current price is £59.99 (down from £79.99).' } }] }),
      ],
      evaluator: [],
    });
    const orch = new Orchestrator({ ollama, registry, settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const result = await orch.runUntilTerminal(await orch.start(t.goal));

    expect(result.phase).toBe('DONE');
    expect(result.verdict).toBe('success');

    const run: BenchRun = {
      phase: result.phase, verdict: result.verdict, summary: result.summary,
      observedText: `${t.goal}\n${state.observedText()}`, turns: result.turns, replans: result.replans,
    };
    const score = scoreRun(t.expect, run);
    expect(score, score.reasons.join('; ')).toMatchObject({ completed: true, correct: true, grounded: true });
  });

  it('field-absent: an honest "rating not shown" finish scores correct (no fabrication) through the real wiring', async () => {
    const t = task('field-absent');
    const state = new ScriptedBrowser(t);
    const registry = buildScriptedRegistry(state);
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'open the Quiet Mechanical Keyboard product and report price, stock, and rating', successCriteria: 'reported' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'tab.open', args: { url: 'https://shop.example/' } }] }),
        rawResponse({ toolCalls: [{ name: 'tab.click', args: { tabId: 101, elementIndex: 1 } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'Price: £51.77. In stock (22 available). Star rating: not shown on the page.' } }] }),
      ],
      evaluator: [],
    });
    const orch = new Orchestrator({ ollama, registry, settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const result = await orch.runUntilTerminal(await orch.start(t.goal));

    expect(result.phase).toBe('DONE');
    const run: BenchRun = {
      phase: result.phase, verdict: result.verdict, summary: result.summary,
      observedText: `${t.goal}\n${state.observedText()}`, turns: result.turns, replans: result.replans,
    };
    const score = scoreRun(t.expect, run);
    expect(score, score.reasons.join('; ')).toMatchObject({ correct: true, grounded: true });
  });

  it('search-list: web search → grounded top-3 ordered report (the highest-blast-radius path)', async () => {
    const t = task('search-list');
    const state = new ScriptedBrowser(t);
    const registry = buildScriptedRegistry(state);
    // No navigation here: search records its results into observedText (search is a READING_TOOL),
    // then the executor reports the top 3 titles in order. Exercises the search-tool wiring + the
    // ordered-list scorer with no page reads.
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'search the web and list the top 3 results by title', successCriteria: 'top 3 listed' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'search', args: { query: 'best mechanical keyboards 2025' } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'Top 3: 1. The 8 Best Mechanical Keyboards (2025) | WIRED. 2. Best Mechanical Keyboards 2025 - RTINGS.com. 3. Top Mechanical Keyboards - Toms Hardware.' } }] }),
      ],
      evaluator: [],
    });
    const orch = new Orchestrator({ ollama, registry, settings: { ...DEFAULT_SETTINGS }, emit: () => undefined });
    const result = await orch.runUntilTerminal(await orch.start(t.goal));

    expect(result.phase).toBe('DONE');
    const run: BenchRun = {
      phase: result.phase, verdict: result.verdict, summary: result.summary,
      observedText: `${t.goal}\n${state.observedText()}`, turns: result.turns, replans: result.replans,
    };
    const score = scoreRun(t.expect, run);
    expect(score, score.reasons.join('; ')).toMatchObject({ completed: true, correct: true, grounded: true });
  });

  it('sale-price with hybridMode explicitly false matches the pre-tiering baseline', async () => {
    const t = task('sale-price');
    const state = new ScriptedBrowser(t);
    const registry = buildScriptedRegistry(state);
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'open the Studio Wireless Headphones product and report its current price', successCriteria: 'current price reported' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'tab.open', args: { url: 'https://shop.example/' } }] }),
        rawResponse({ toolCalls: [{ name: 'tab.click', args: { tabId: 101, elementIndex: 1 } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'The current price is £59.99 (down from £79.99).' } }] }),
      ],
      evaluator: [],
    });
    const orch = new Orchestrator({
      ollama,
      registry,
      settings: { ...DEFAULT_SETTINGS, hybridMode: false },
      emit: () => undefined,
    });
    const result = await orch.runUntilTerminal(await orch.start(t.goal));

    expect(result.phase).toBe('DONE');
    expect(result.verdict).toBe('success');

    const run: BenchRun = {
      phase: result.phase, verdict: result.verdict, summary: result.summary,
      observedText: `${t.goal}\n${state.observedText()}`, turns: result.turns, replans: result.replans,
    };
    const score = scoreRun(t.expect, run);
    expect(score, score.reasons.join('; ')).toMatchObject({ completed: true, correct: true, grounded: true });
  });

  it('sale-price with hybridMode false but leadThinking true still completes correctly', async () => {
    const t = task('sale-price');
    const state = new ScriptedBrowser(t);
    const registry = buildScriptedRegistry(state);
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'open the Studio Wireless Headphones product and report its current price', successCriteria: 'current price reported' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'tab.open', args: { url: 'https://shop.example/' } }] }),
        rawResponse({ toolCalls: [{ name: 'tab.click', args: { tabId: 101, elementIndex: 1 } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'The current price is £59.99 (down from £79.99).' } }] }),
      ],
      evaluator: [],
    });
    const orch = new Orchestrator({
      ollama,
      registry,
      settings: { ...DEFAULT_SETTINGS, hybridMode: false, leadThinking: true },
      emit: () => undefined,
    });
    const result = await orch.runUntilTerminal(await orch.start(t.goal));

    expect(result.phase).toBe('DONE');
    expect(result.verdict).toBe('success');

    const run: BenchRun = {
      phase: result.phase, verdict: result.verdict, summary: result.summary,
      observedText: `${t.goal}\n${state.observedText()}`, turns: result.turns, replans: result.replans,
    };
    const score = scoreRun(t.expect, run);
    expect(score, score.reasons.join('; ')).toMatchObject({ completed: true, correct: true, grounded: true });
  });
});
