// A fixture-backed ToolRegistry: the same tool surface the real agent sees, but
// browser tools return scripted page content and advance a small per-fixture state
// machine instead of driving Chrome/CDP. Reuses the REAL core tools so finish/
// next_step behave identically.

import { z } from 'zod';
import { ToolRegistry, type ToolContext, type ToolResult } from '@/agent/tools/registry';
import { echoTool, finishTool, nextStepTool, memoryReadTool, memoryWriteTool, memoryListTool } from '@/agent/tools/core';
import { patchHot } from '@/background/state_store';
import type { BenchTask, SearchHit } from './fixtures';

export class ScriptedBrowser {
  private tabState = new Map<number, string>();
  private lastResults: SearchHit[] = [];
  private observed: string[] = [];

  constructor(public task: BenchTask) {
    if (task.profileJson) this.observed.push(task.profileJson); // profile is ground truth
  }

  observedText(): string {
    return this.observed.join('\n\n');
  }

  private record(text: string): void {
    if (text) this.observed.push(text);
  }

  private pageAria(key: string): { url: string; aria: string } {
    const p = this.task.pages[key];
    if (p) return p;
    return { url: 'about:blank', aria: '   heading "Not found"\n   text "404 — page not available."' };
  }

  private transition(from: string, tool: string, args: Record<string, unknown>): string {
    const idx = (args.elementIndex ?? args.index) as number | undefined;
    for (const t of this.task.transitions) {
      if (t.from !== from || t.when.tool !== tool) continue;
      if (t.when.submit !== undefined && (args.submit ?? false) !== t.when.submit) continue;
      if (t.when.index !== undefined && idx !== t.when.index) continue;
      return t.to;
    }
    return from; // no edge → stay (e.g. filling a field without submitting)
  }

  async openTab(url: string, ctx: ToolContext): Promise<ToolResult> {
    const tabId = await new Promise<number>((resolve) =>
      chrome.tabs.create({ url, active: false }, (t) => resolve(t.id!)),
    );
    this.tabState.set(tabId, this.task.start);
    const next = [...ctx.hot.ownedTabs, tabId];
    await patchHot({ ownedTabs: next });
    ctx.hot.ownedTabs = next;
    return { ok: true, content: `Opened tab ${tabId} at ${url}`, data: { tabId, url } };
  }

  extract(tabId: number): ToolResult {
    const key = this.tabState.get(tabId) ?? this.task.start;
    const { url, aria } = this.pageAria(key);
    this.record(aria);
    return { ok: true, content: aria, data: { url, nodeCount: 2, interactiveCount: 1, truncated: false, sparse: false } };
  }

  act(tool: string, tabId: number, args: Record<string, unknown>): ToolResult {
    const from = this.tabState.get(tabId) ?? this.task.start;
    this.tabState.set(tabId, this.transition(from, tool, args));
    const label =
      tool === 'tab.type'
        ? `Typed ${(args.text as string)?.length ?? 0} chars${args.submit ? ' and submitted' : ''}`
        : tool === 'tab.click'
          ? `Clicked element [${args.elementIndex}]`
          : `${tool} ok`;
    return { ok: true, content: label, data: { tabId } };
  }

  search(query: string): ToolResult {
    void query;
    this.lastResults = this.task.search ?? [];
    if (!this.lastResults.length) return { ok: false, content: 'No results parsed.' };
    const lines = this.lastResults.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`);
    const content = `${lines.join('\n\n')}\n\n(To open one, call open_result with its number — e.g. {"index": 1}.)`;
    this.record(content);
    return { ok: true, content, data: { results: this.lastResults as unknown as Record<string, unknown> } };
  }

  async openResult(index: number, ctx: ToolContext): Promise<ToolResult> {
    const r = this.lastResults[index - 1];
    if (!r) return { ok: false, content: `No result #${index}.` };
    return this.openTab(r.url, ctx);
  }
}

export function buildScriptedRegistry(state: ScriptedBrowser): ToolRegistry {
  const r = new ToolRegistry();
  // Real core tools (identical behaviour to production).
  r.register(echoTool);
  r.register(nextStepTool);
  r.register(finishTool);
  r.register(memoryReadTool);
  r.register(memoryWriteTool);
  r.register(memoryListTool);

  // Scripted browser tools (same names/descriptions the real agent is trained on).
  r.register({
    name: 'tab.open',
    description: 'Open a new tab at an EXACT URL copied from observed content. For SEARCH results use open_result instead.',
    argsSchema: z.object({ url: z.string() }),
    dispatch: ({ url }, ctx) => state.openTab(url, ctx),
  });
  r.register({
    name: 'open_result',
    description: 'Open one of the most recent search results by its number (e.g. {"index":1}).',
    argsSchema: z.object({ index: z.number().int().positive() }),
    dispatch: ({ index }, ctx) => state.openResult(index, ctx),
  });
  r.register({
    name: 'aria.extract',
    description: 'Extract the simplified ARIA accessibility tree for a tab. Returns the indexed tree text.',
    argsSchema: z.object({ tabId: z.number().int() }),
    dispatch: async ({ tabId }) => state.extract(tabId),
  });
  r.register({
    name: 'vision.read',
    description: 'Read a page VISUALLY via screenshot. Fallback when aria.extract returns little or no content.',
    argsSchema: z.object({ tabId: z.number().int(), question: z.string().optional() }),
    dispatch: async ({ tabId }) => state.extract(tabId),
  });
  r.register({
    name: 'tab.wait_loaded',
    description: 'Wait for a tab to reach status "complete". Call after navigation.',
    argsSchema: z.object({ tabId: z.number().int(), timeoutMs: z.number().int().optional() }),
    dispatch: async ({ tabId }) => ({ ok: true, content: `Tab ${tabId} loaded`, data: { tabId } }),
  });
  r.register({
    name: 'tab.click',
    description: 'Click an interactive element by its ARIA tree index. Requires click-only tier or higher.',
    argsSchema: z.object({ tabId: z.number().int(), elementIndex: z.number().int().positive() }),
    dispatch: async ({ tabId, elementIndex }) => state.act('tab.click', tabId, { elementIndex }),
  });
  r.register({
    name: 'tab.type',
    description: 'Type text into a field by ARIA tree index. submit=true submits the form / presses Enter.',
    argsSchema: z.object({
      tabId: z.number().int(), elementIndex: z.number().int().positive(),
      text: z.string(), clear: z.boolean().optional(), submit: z.boolean().optional(),
    }),
    dispatch: async ({ tabId, elementIndex, text, submit }) => state.act('tab.type', tabId, { elementIndex, text, submit }),
  });
  r.register({
    name: 'search',
    description: 'Web search via DuckDuckGo. Returns title, url, and snippet for each result.',
    argsSchema: z.object({ query: z.string().min(1), max: z.number().int().optional() }),
    dispatch: async ({ query }) => state.search(query),
  });
  return r;
}
