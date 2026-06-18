import { describe, it, expect, beforeEach } from 'vitest';
import { _setHot, clearHot } from '@/background/state_store';
import type { ToolContext } from '@/agent/tools/registry';
import { OllamaClient } from '@/background/ollama';
import { DEFAULT_SETTINGS } from '@/shared/messages';
import { ScriptedBrowser, buildScriptedRegistry } from './scripted_browser';
import { BENCH_TASKS } from './fixtures';

const shopDetail = BENCH_TASKS.find((t) => t.id === 'shop-detail')!;

function ctx(): ToolContext {
  return {
    taskId: 't', signal: new AbortController().signal,
    hot: { goal: 'g', phase: 'EXECUTING', currentStepId: null, plan: null, replanCount: 0, ownedTabs: [], lastTouch: 0, startedAt: 0 },
    settings: { ...DEFAULT_SETTINGS },
    ollama: new OllamaClient('http://localhost:11434'),
    emit: () => undefined,
    addFinding: async () => undefined,
  };
}

beforeEach(async () => { await clearHot(); await _setHot('g'); });

describe('ScriptedBrowser', () => {
  it('aria.extract returns the start page, then results after a submit, then product after a click', async () => {
    const state = new ScriptedBrowser(shopDetail);
    const reg = buildScriptedRegistry(state);
    const c = ctx();

    const open = await reg.dispatch('tab.open', { url: 'https://shop.example/' }, c);
    const tabId = open.data!.tabId as number;

    const home = await reg.dispatch('aria.extract', { tabId }, c);
    expect(home.content).toContain('searchbox');

    await reg.dispatch('tab.type', { tabId, elementIndex: 1, text: 'wireless mouse', submit: true }, c);
    const results = await reg.dispatch('aria.extract', { tabId }, c);
    expect(results.content).toContain('Logitech M185');

    await reg.dispatch('tab.click', { tabId, elementIndex: 1 }, c);
    const product = await reg.dispatch('aria.extract', { tabId }, c);
    expect(product.content).toContain('Rating: 4.6');
  });

  it('records everything observed (for grounding) including search output', async () => {
    const searchList = BENCH_TASKS.find((t) => t.id === 'search-list')!;
    const state = new ScriptedBrowser(searchList);
    const reg = buildScriptedRegistry(state);
    const res = await reg.dispatch('search', { query: 'best mechanical keyboards 2025' }, ctx());
    expect(res.content).toContain('WIRED');
    expect(state.observedText()).toContain('RTINGS');
  });

  it('reflects typed values back into the page so a re-read shows filled fields', async () => {
    const jobApply = BENCH_TASKS.find((t) => t.id === 'job-apply')!;
    const state = new ScriptedBrowser(jobApply);
    const reg = buildScriptedRegistry(state);
    const c = ctx();
    const open = await reg.dispatch('tab.open', { url: 'https://jobs.example/apply' }, c);
    const tabId = open.data!.tabId as number;
    await reg.dispatch('tab.type', { tabId, elementIndex: 1, text: 'Jane Doe' }, c);
    const form = await reg.dispatch('aria.extract', { tabId }, c);
    expect(form.content).toContain('"Full name" ="Jane Doe"');
  });

  it('finish surfaces the verdict/summary to the orchestrator', async () => {
    const state = new ScriptedBrowser(shopDetail);
    const reg = buildScriptedRegistry(state);
    const r = await reg.dispatch('finish', { verdict: 'success', summary: 'done' }, ctx());
    expect(r.finish).toEqual({ verdict: 'success', summary: 'done' });
  });
});
