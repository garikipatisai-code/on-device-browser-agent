# Task-Success Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deterministic, end-to-end task-success benchmark that runs the real planner→executor→evaluator loop against the real local model over scripted multi-page fixtures, scored by assertion + grounding (a built-in hallucination detector).

**Architecture:** Three deterministic, unit-tested pieces — fixtures (data), a scripted `ToolRegistry` (browser tools backed by fixture state instead of Chrome/CDP), and a pure scorer — plus one env-gated vitest runner that wires them to a real `OllamaClient` and prints a report. The runner reuses the existing chrome stub (`tests/setup.ts`) and `fake-indexeddb`, so `state_store` works under Node. The deterministic pieces run in normal `npm test`; the live runner is gated behind `OLLAMA_BENCH=1 npm run bench` and is run by the user (the dev sandbox cannot reach the Ollama socket).

**Tech Stack:** TypeScript, vitest, zod (existing tool registry), the existing `Orchestrator`, `ToolRegistry`, and `OllamaClient`.

**Spec:** `docs/superpowers/specs/2026-06-17-task-success-benchmark-design.md`

---

## File Structure

| File | Responsibility |
|------|----------------|
| `extension/tests/bench/fixtures.ts` | Fixture types + 5 seed `BenchTask`s (data only). |
| `extension/tests/bench/fixtures.test.ts` | Structural validation: every fixture is well-formed. |
| `extension/tests/bench/scorer.ts` | Pure scorer: `completed` / `correct` / `grounded` + number-grounding. |
| `extension/tests/bench/scorer.test.ts` | Unit tests incl. a planted hallucination and list-marker false-positive guard. |
| `extension/tests/bench/scripted_browser.ts` | `ScriptedBrowser` (per-run state) + `buildScriptedRegistry()` (fixture-backed `ToolRegistry`). |
| `extension/tests/bench/scripted_browser.test.ts` | Unit tests: aria returns current page; transitions advance state. |
| `extension/tests/bench/report.ts` | Pure report aggregation/formatting (`measure_toolcalls`-style output). |
| `extension/tests/bench/report.test.ts` | Unit tests for aggregation math + formatting. |
| `extension/tests/bench/run.bench.test.ts` | Env-gated runner: real `OllamaClient` + real `Orchestrator` per trial → score → report. |
| `extension/package.json` | Add `"bench"` script. |
| `extension/README.md` | Document `npm run bench`. |

All new code lives under `extension/tests/bench/`. No `src/` files change (this is measurement infra only).

---

## Task 1: Fixture types + seed fixtures

**Files:**
- Create: `extension/tests/bench/fixtures.ts`
- Test: `extension/tests/bench/fixtures.test.ts`

- [ ] **Step 1: Write the failing test**

Create `extension/tests/bench/fixtures.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { BENCH_TASKS } from './fixtures';

describe('bench fixtures are well-formed', () => {
  it('has at least the 5 seed tasks with unique ids', () => {
    expect(BENCH_TASKS.length).toBeGreaterThanOrEqual(5);
    const ids = BENCH_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every task: non-empty goal, a start page that exists, and valid transitions', () => {
    for (const t of BENCH_TASKS) {
      expect(t.goal.trim().length).toBeGreaterThan(0);
      // A task either navigates real pages (has a start page) or is search-only.
      if (Object.keys(t.pages).length > 0) {
        expect(t.pages[t.start], `${t.id}: start page "${t.start}" missing`).toBeTruthy();
      }
      for (const tr of t.transitions) {
        expect(t.pages[tr.from], `${t.id}: transition.from "${tr.from}" missing`).toBeTruthy();
        expect(t.pages[tr.to], `${t.id}: transition.to "${tr.to}" missing`).toBeTruthy();
      }
      expect(t.expect.verdict.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run tests/bench/fixtures.test.ts`
Expected: FAIL — `Cannot find module './fixtures'`.

- [ ] **Step 3: Write the implementation**

Create `extension/tests/bench/fixtures.ts`:

```ts
// Scripted multi-page task fixtures for the task-success benchmark.
// `aria` strings use the real serializeTree format: `[n] role "name"` for indexed
// interactive elements, indented plain lines for text. The model sees exactly what
// the real aria.extract produces.

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface BenchPage {
  url: string;
  aria: string;
}

/** A state edge: when `tool` is called from page `from` (optionally matching submit
 *  or element index), move to page `to`. */
export interface Transition {
  from: string;
  when: { tool: string; submit?: boolean; index?: number };
  to: string;
}

export interface Expectation {
  /** Acceptable finish verdicts (e.g. ['success'] or ['blocked','failed']). */
  verdict: string[];
  /** Each must be present in finish.summary (string = substring, RegExp = test). */
  mustContain?: Array<string | RegExp>;
  /** These substrings must appear in finish.summary IN THIS ORDER (ranked lists). */
  orderedList?: string[];
  /** Declared entities: if present in the summary, must also be in observed text. */
  entities?: string[];
}

export interface BenchTask {
  id: string;
  goal: string;
  pages: Record<string, BenchPage>;
  /** Page a freshly opened tab lands on (single-site fixtures). */
  start: string;
  transitions: Transition[];
  /** Results returned by the scripted `search` tool, if the task uses web search. */
  search?: SearchHit[];
  /** Injected into Settings.profileJson (job-apply). Also counted as grounded truth. */
  profileJson?: string;
  expect: Expectation;
}

export const BENCH_TASKS: BenchTask[] = [
  {
    id: 'shop-detail',
    goal: 'go to shop.example, search for "wireless mouse", open the first product, and report its title, price, and rating',
    start: 'home',
    pages: {
      home: {
        url: 'https://shop.example/',
        aria: `[1] searchbox "Search shop.example"\n[2] button "Go"`,
      },
      results: {
        url: 'https://shop.example/s?k=wireless+mouse',
        aria:
          `[1] link "Logitech M185 Wireless Mouse"\n   text "$13.42"\n` +
          `[2] link "Anker 2.4G Wireless Mouse"\n   text "$19.99"\n` +
          `[3] link "VicTsing Mini Mouse"\n   text "$11.99"`,
      },
      product: {
        url: 'https://shop.example/dp/m185',
        aria:
          `   heading "Logitech M185 Wireless Mouse"\n` +
          `   text "Price: $13.42"\n` +
          `   text "Rating: 4.6 out of 5 stars"\n` +
          `[1] button "Add to Cart"`,
      },
    },
    transitions: [
      { from: 'home', when: { tool: 'tab.type', submit: true }, to: 'results' },
      { from: 'results', when: { tool: 'tab.click', index: 1 }, to: 'product' },
    ],
    expect: {
      verdict: ['success'],
      mustContain: ['Logitech M185', /\$13\.42/, /4\.6/],
      entities: ['Logitech M185 Wireless Mouse'],
    },
  },

  {
    id: 'search-list',
    goal: 'search the web for "best mechanical keyboards 2025" and list the top 3 results by title',
    start: 'home',
    pages: {},
    transitions: [],
    search: [
      { title: 'The 8 Best Mechanical Keyboards (2025) | WIRED', url: 'https://wired.com/best-keyboards', snippet: 'Our picks after months of testing.' },
      { title: 'Best Mechanical Keyboards 2025 - RTINGS.com', url: 'https://rtings.com/keyboard/best', snippet: 'Tested side by side.' },
      { title: 'Top Mechanical Keyboards - Toms Hardware', url: 'https://tomshardware.com/best-keyboards', snippet: 'Reviews and buying advice.' },
      { title: 'r/MechanicalKeyboards Best of 2025', url: 'https://reddit.com/r/MechanicalKeyboards', snippet: 'Community favourites.' },
      { title: 'Keychron Official Store', url: 'https://keychron.com', snippet: 'Buy direct.' },
    ],
    expect: {
      verdict: ['success'],
      mustContain: ['WIRED', 'RTINGS', /Toms Hardware/],
      orderedList: ['WIRED', 'RTINGS', 'Toms Hardware'],
    },
  },

  {
    id: 'rank-extract',
    goal: 'on shop.example, search for "usb c cable" and report the 3 cheapest by price, cheapest first, with prices',
    start: 'home',
    pages: {
      home: {
        url: 'https://shop.example/',
        aria: `[1] searchbox "Search shop.example"\n[2] button "Go"`,
      },
      results: {
        url: 'https://shop.example/s?k=usb+c+cable',
        aria:
          `[1] link "Cable A 1m"\n   text "$7.99"\n` +
          `[2] link "Cable B braided 2m"\n   text "$12.50"\n` +
          `[3] link "Cable C basic"\n   text "$4.99"\n` +
          `[4] link "Cable D fast charge"\n   text "$9.99"\n` +
          `[5] link "Cable E premium"\n   text "$15.00"`,
      },
    },
    transitions: [
      { from: 'home', when: { tool: 'tab.type', submit: true }, to: 'results' },
    ],
    expect: {
      verdict: ['success'],
      mustContain: [/\$4\.99/, /\$7\.99/, /\$9\.99/],
      orderedList: ['$4.99', '$7.99', '$9.99'],
    },
  },

  {
    id: 'empty-honesty',
    goal: 'find the price of the "Acme Quantum Blender 9000" on shop.example and report it',
    start: 'home',
    pages: {
      home: {
        url: 'https://shop.example/',
        aria: `[1] searchbox "Search shop.example"\n[2] button "Go"`,
      },
      noresults: {
        url: 'https://shop.example/s?k=acme+quantum+blender+9000',
        aria:
          `   heading "No results"\n` +
          `   text "We could not find any matches for your search."`,
      },
    },
    transitions: [
      { from: 'home', when: { tool: 'tab.type', submit: true }, to: 'noresults' },
    ],
    expect: {
      // Honest outcome: report that it could not be found — NOT a made-up price.
      verdict: ['blocked', 'failed'],
      mustContain: [/no results|could ?n.?t find|not found|no match|unavailable/i],
    },
  },

  {
    id: 'job-apply',
    goal: 'apply to the job at jobs.example: fill the application form from my profile and submit it',
    start: 'form',
    profileJson: '{"name":"Jane Doe","email":"jane.doe@example.com","phone":"555-0142"}',
    pages: {
      form: {
        url: 'https://jobs.example/apply',
        aria:
          `[1] textbox "Full name"\n` +
          `[2] textbox "Email"\n` +
          `[3] textbox "Phone"\n` +
          `[4] button "Submit application"`,
      },
      confirm: {
        url: 'https://jobs.example/apply/done',
        aria:
          `   heading "Application received"\n` +
          `   text "Thanks, Jane Doe - we will be in touch."`,
      },
    },
    transitions: [
      { from: 'form', when: { tool: 'tab.click', index: 4 }, to: 'confirm' },
    ],
    expect: {
      verdict: ['success'],
      mustContain: [/received|submitted|applied|complete/i],
      entities: ['Jane Doe'],
    },
  },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run tests/bench/fixtures.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/tests/bench/fixtures.ts extension/tests/bench/fixtures.test.ts
git commit -m "test(bench): seed task fixtures + structural validation"
```

---

## Task 2: Pure scorer (the deterministic heart)

**Files:**
- Create: `extension/tests/bench/scorer.ts`
- Test: `extension/tests/bench/scorer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `extension/tests/bench/scorer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { dataNumbers, ungroundedNumbers, scoreRun, type BenchRun } from './scorer';

const PAGES = 'Logitech M185 Wireless Mouse Price: $13.42 Rating: 4.6 out of 5 stars';

function run(over: Partial<BenchRun>): BenchRun {
  return {
    phase: 'DONE', verdict: 'success',
    summary: '', observedText: PAGES, turns: 3, replans: 0,
    ...over,
  };
}

describe('dataNumbers', () => {
  it('extracts prices, decimals and multi-digit ints; ignores single-digit list markers', () => {
    expect(dataNumbers('1. M185 $13.42 rated 4.6')).toEqual(['13.42', '4.6']);
    expect(dataNumbers('top 3 results')).toEqual([]); // "3" is a single digit → ignored
    expect(dataNumbers('year 2025')).toEqual(['2025']);
  });
});

describe('ungroundedNumbers', () => {
  it('flags a number absent from observed text (hallucination), passes a present one', () => {
    expect(ungroundedNumbers('It costs $13.42', PAGES)).toEqual([]);
    expect(ungroundedNumbers('It costs $99.99', PAGES)).toEqual(['99.99']);
  });
});

describe('scoreRun', () => {
  it('all green when verdict + facts match and numbers are grounded', () => {
    const s = scoreRun(
      { verdict: ['success'], mustContain: ['Logitech M185', /\$13\.42/, /4\.6/] },
      run({ summary: 'Logitech M185 Wireless Mouse — $13.42, rated 4.6' }),
    );
    expect(s).toMatchObject({ completed: true, correct: true, grounded: true });
  });

  it('grounded=false when the answer invents a price', () => {
    const s = scoreRun(
      { verdict: ['success'], mustContain: ['Logitech M185'] },
      run({ summary: 'Logitech M185 Wireless Mouse — $99.99' }),
    );
    expect(s.correct).toBe(true);     // the required string is present
    expect(s.grounded).toBe(false);   // but $99.99 is not on any page → hallucination
    expect(s.reasons.join(' ')).toContain('99.99');
  });

  it('correct=false when a required fact is missing', () => {
    const s = scoreRun(
      { verdict: ['success'], mustContain: ['Logitech M185', /4\.6/] },
      run({ summary: 'Some mouse, no rating given' }),
    );
    expect(s.correct).toBe(false);
  });

  it('correct=false when verdict is not in the accepted set', () => {
    const s = scoreRun({ verdict: ['blocked', 'failed'] }, run({ verdict: 'success', summary: 'here it is' }));
    expect(s.correct).toBe(false);
  });

  it('completed=false when the run aborted (loop / max-turns)', () => {
    const s = scoreRun({ verdict: ['success'] }, run({ phase: 'ABORTED', verdict: 'aborted' }));
    expect(s.completed).toBe(false);
  });

  it('orderedList must appear in order', () => {
    const exp = { verdict: ['success'], orderedList: ['$4.99', '$7.99', '$9.99'] };
    const obs = 'Cable C $4.99 Cable A $7.99 Cable D $9.99';
    expect(scoreRun(exp, run({ summary: '1. $4.99 2. $7.99 3. $9.99', observedText: obs })).correct).toBe(true);
    expect(scoreRun(exp, run({ summary: '1. $7.99 2. $4.99 3. $9.99', observedText: obs })).correct).toBe(false);
  });

  it('empty-honesty: an honest "no results" answer is correct AND grounded', () => {
    const s = scoreRun(
      { verdict: ['blocked', 'failed'], mustContain: [/no results|not found/i] },
      run({ phase: 'DONE', verdict: 'blocked', summary: 'No results found for that product.', observedText: 'No results' }),
    );
    expect(s).toMatchObject({ completed: true, correct: true, grounded: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run tests/bench/scorer.test.ts`
Expected: FAIL — `Cannot find module './scorer'`.

- [ ] **Step 3: Write the implementation**

Create `extension/tests/bench/scorer.ts`:

```ts
// Pure, deterministic scorer for a single benchmark run. No model calls.

import type { Expectation } from './fixtures';

export interface BenchRun {
  phase: 'DONE' | 'ABORTED';
  verdict: string;        // finish verdict (success|partial|blocked|failed|aborted)
  summary: string;        // finish.summary — the user-facing answer
  observedText: string;   // all aria.extract + search outputs seen this run (+ profileJson)
  turns: number;
  replans: number;
}

export interface Score {
  completed: boolean;
  correct: boolean;
  grounded: boolean;
  reasons: string[];      // human-readable failure notes
}

// Currency, decimals (ratings/prices), or multi-digit integers (years, counts).
// Bare single digits (list markers "1.", "top 3") are intentionally NOT matched,
// so they never produce a false hallucination flag.
const NUM_RE = /\$\s?\d[\d,]*(?:\.\d+)?|\b\d+\.\d+\b|\b\d{2,}\b/g;

function normNum(tok: string): string {
  return tok.replace(/[$\s,]/g, '');
}

export function dataNumbers(s: string): string[] {
  const m = s.match(NUM_RE);
  if (!m) return [];
  return [...new Set(m.map(normNum))];
}

/** Numbers in `summary` that do NOT appear anywhere in `observed`. */
export function ungroundedNumbers(summary: string, observed: string): string[] {
  const obs = observed.replace(/[$\s,]/g, '');
  return dataNumbers(summary).filter((n) => !obs.includes(n));
}

function matches(summary: string, m: string | RegExp): boolean {
  return typeof m === 'string' ? summary.includes(m) : m.test(summary);
}

function inOrder(summary: string, items: string[]): boolean {
  let idx = 0;
  for (const it of items) {
    const at = summary.indexOf(it, idx);
    if (at < 0) return false;
    idx = at + it.length;
  }
  return true;
}

export function scoreRun(exp: Expectation, run: BenchRun): Score {
  const reasons: string[] = [];

  const completed = run.phase === 'DONE';
  if (!completed) reasons.push(`did not complete (phase=${run.phase}, verdict=${run.verdict})`);

  // correct
  let correct = true;
  if (!exp.verdict.includes(run.verdict)) {
    correct = false;
    reasons.push(`verdict ${run.verdict} not in [${exp.verdict.join(',')}]`);
  }
  for (const m of exp.mustContain ?? []) {
    if (!matches(run.summary, m)) {
      correct = false;
      reasons.push(`missing required: ${m.toString()}`);
    }
  }
  if (exp.orderedList && !inOrder(run.summary, exp.orderedList)) {
    correct = false;
    reasons.push(`not in order: [${exp.orderedList.join(', ')}]`);
  }

  // grounded
  let grounded = true;
  const ungrounded = ungroundedNumbers(run.summary, run.observedText);
  if (ungrounded.length) {
    grounded = false;
    reasons.push(`ungrounded numbers (hallucinated): ${ungrounded.join(', ')}`);
  }
  const obsLC = run.observedText.toLowerCase();
  const sumLC = run.summary.toLowerCase();
  for (const e of exp.entities ?? []) {
    const eLC = e.toLowerCase();
    if (sumLC.includes(eLC) && !obsLC.includes(eLC)) {
      grounded = false;
      reasons.push(`ungrounded entity: "${e}"`);
    }
  }

  return { completed, correct, grounded, reasons };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run tests/bench/scorer.test.ts`
Expected: PASS (all `describe` blocks green).

- [ ] **Step 5: Commit**

```bash
git add extension/tests/bench/scorer.ts extension/tests/bench/scorer.test.ts
git commit -m "test(bench): pure scorer with number-grounding hallucination check"
```

---

## Task 3: Scripted browser registry

**Files:**
- Create: `extension/tests/bench/scripted_browser.ts`
- Test: `extension/tests/bench/scripted_browser.test.ts`

- [ ] **Step 1: Write the failing test**

Create `extension/tests/bench/scripted_browser.test.ts`:

```ts
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

  it('finish surfaces the verdict/summary to the orchestrator', async () => {
    const state = new ScriptedBrowser(shopDetail);
    const reg = buildScriptedRegistry(state);
    const r = await reg.dispatch('finish', { verdict: 'success', summary: 'done' }, ctx());
    expect(r.finish).toEqual({ verdict: 'success', summary: 'done' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run tests/bench/scripted_browser.test.ts`
Expected: FAIL — `Cannot find module './scripted_browser'`.

- [ ] **Step 3: Write the implementation**

Create `extension/tests/bench/scripted_browser.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run tests/bench/scripted_browser.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/tests/bench/scripted_browser.ts extension/tests/bench/scripted_browser.test.ts
git commit -m "test(bench): fixture-backed scripted browser registry"
```

---

## Task 4: Report aggregation/formatting

**Files:**
- Create: `extension/tests/bench/report.ts`
- Test: `extension/tests/bench/report.test.ts`

- [ ] **Step 1: Write the failing test**

Create `extension/tests/bench/report.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { aggregate, formatReport, type TaskResult } from './report';
import type { Score } from './scorer';

const score = (o: Partial<Score>): Score => ({ completed: true, correct: true, grounded: true, reasons: [], ...o });

const results: TaskResult[] = [
  { id: 'a', scores: [score({}), score({ grounded: false })], turns: [3, 4] },
  { id: 'b', scores: [score({ correct: false, grounded: false })], turns: [9] },
];

describe('aggregate', () => {
  it('computes per-dimension rates over all trials', () => {
    const agg = aggregate(results);
    expect(agg.total).toBe(3);               // 2 + 1 trials
    expect(agg.completed).toBe(3);           // all completed
    expect(agg.correct).toBe(2);             // a×2 correct, b×0
    expect(agg.grounded).toBe(1);            // only a-trial-1
  });
});

describe('formatReport', () => {
  it('renders per-task lines and a totals block', () => {
    const out = formatReport(results, { model: 'gemma4:e4b', trials: 2 });
    expect(out).toContain('gemma4:e4b');
    expect(out).toContain('a ');
    expect(out).toContain('grounded');
    expect(out).toMatch(/completed\s+\d+%/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run tests/bench/report.test.ts`
Expected: FAIL — `Cannot find module './report'`.

- [ ] **Step 3: Write the implementation**

Create `extension/tests/bench/report.ts`:

```ts
// Pure aggregation + formatting of benchmark results. No I/O.

import type { Score } from './scorer';

export interface TaskResult {
  id: string;
  scores: Score[];
  turns: number[];
}

export interface Aggregate {
  total: number;
  completed: number;
  correct: number;
  grounded: number;
  meanTurns: number;
}

export function aggregate(results: TaskResult[]): Aggregate {
  let total = 0, completed = 0, correct = 0, grounded = 0, turnSum = 0, turnN = 0;
  for (const t of results) {
    for (const s of t.scores) {
      total++;
      if (s.completed) completed++;
      if (s.correct) correct++;
      if (s.grounded) grounded++;
    }
    for (const n of t.turns) { turnSum += n; turnN++; }
  }
  return { total, completed, correct, grounded, meanTurns: turnN ? turnSum / turnN : 0 };
}

function pct(n: number, d: number): string {
  return `${d ? Math.round((n / d) * 100) : 0}%`.padStart(4);
}

export function formatReport(results: TaskResult[], opts: { model: string; trials: number }): string {
  const lines: string[] = [];
  lines.push(`\nTask-success benchmark — model=${opts.model}, trials/task=${opts.trials}\n`);
  for (const t of results) {
    const n = t.scores.length;
    const c = t.scores.filter((s) => s.completed).length;
    const ok = t.scores.filter((s) => s.correct).length;
    const g = t.scores.filter((s) => s.grounded).length;
    lines.push(
      `  ${t.id.padEnd(14)} completed ${pct(c, n)}  correct ${pct(ok, n)}  grounded ${pct(g, n)}`,
    );
    // Surface the first failure reason per task to make regressions debuggable.
    const firstBad = t.scores.find((s) => !s.correct || !s.grounded || !s.completed);
    if (firstBad && firstBad.reasons.length) lines.push(`                 ↳ ${firstBad.reasons[0]}`);
  }
  const a = aggregate(results);
  lines.push(`\n  ── totals over ${a.total} runs ──`);
  lines.push(`  completed ${pct(a.completed, a.total)}   correct ${pct(a.correct, a.total)}   grounded ${pct(a.grounded, a.total)}`);
  lines.push(`  mean turns ${a.meanTurns.toFixed(1)}`);
  lines.push(`  (grounded = no hallucinated numbers in the answer — the headline accuracy signal)\n`);
  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run tests/bench/report.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/tests/bench/report.ts extension/tests/bench/report.test.ts
git commit -m "test(bench): report aggregation + formatting"
```

---

## Task 5: Live runner + npm script + docs

**Files:**
- Create: `extension/tests/bench/run.bench.test.ts`
- Modify: `extension/package.json` (scripts)
- Modify: `extension/README.md` (Development section)

- [ ] **Step 1: Write the runner**

Create `extension/tests/bench/run.bench.test.ts`. It is gated by `OLLAMA_BENCH` so `npm test` skips it, and uses the `node` environment so the real `OllamaClient` (undici fetch) reaches `localhost` directly without proxy interference.

```ts
// @vitest-environment node
//
// Live task-success benchmark. Runs the REAL orchestrator loop against the REAL
// local model over scripted fixtures. Gated: only runs under `npm run bench`
// (OLLAMA_BENCH=1). The dev sandbox cannot reach Ollama — the user runs this.
//
//   npm run bench
//   OLLAMA_BENCH_MODEL=gemma4:e4b OLLAMA_BENCH_TRIALS=3 npm run bench

import { describe, it, expect } from 'vitest';
import { Orchestrator } from '@/agent/orchestrator';
import { OllamaClient } from '@/background/ollama';
import { DEFAULT_SETTINGS } from '@/shared/messages';
import { clearHot } from '@/background/state_store';
import { resetStorage } from '../helpers';
import { BENCH_TASKS } from './fixtures';
import { ScriptedBrowser, buildScriptedRegistry } from './scripted_browser';
import { scoreRun, type BenchRun, type Score } from './scorer';
import { formatReport, type TaskResult } from './report';

const RUN = !!process.env.OLLAMA_BENCH;
const MODEL = process.env.OLLAMA_BENCH_MODEL || 'gemma4:e4b';
const TRIALS = Number.parseInt(process.env.OLLAMA_BENCH_TRIALS || '3', 10);
const BASE = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

describe.skipIf(!RUN)('task-success benchmark (live model)', () => {
  it(
    `runs ${BENCH_TASKS.length} tasks × ${TRIALS} trials on ${MODEL}`,
    async () => {
      const ollama = new OllamaClient(BASE);
      expect(await ollama.ping(), `Ollama unreachable at ${BASE} — is "ollama serve" running?`).toBe(true);

      const results: TaskResult[] = [];

      for (const task of BENCH_TASKS) {
        const scores: Score[] = [];
        const turns: number[] = [];

        for (let i = 0; i < TRIALS; i++) {
          await resetStorage();        // seed-only workflow memory each trial → independence
          await clearHot();

          const state = new ScriptedBrowser(task);
          const registry = buildScriptedRegistry(state);
          const settings = {
            ...DEFAULT_SETTINGS,
            plannerModel: MODEL, executorModel: MODEL, evaluatorModel: MODEL,
            compactorModel: MODEL, visionModel: MODEL,
            profileJson: task.profileJson ?? '',
          };

          const orch = new Orchestrator({ ollama, registry, settings, emit: () => undefined });
          let phase: 'DONE' | 'ABORTED' = 'ABORTED';
          let verdict = 'aborted';
          let summary = '';
          try {
            const initial = await orch.start(task.goal);
            const result = await orch.runUntilTerminal(initial);
            phase = result.phase;
            verdict = result.verdict;
            summary = result.summary;
            turns.push(result.turns);
          } catch (err) {
            summary = `ERROR: ${(err as Error).message}`;
          }

          const run: BenchRun = {
            phase, verdict, summary,
            observedText: `${state.observedText()}\n${task.profileJson ?? ''}`,
            turns: turns[turns.length - 1] ?? 0,
            replans: 0,
          };
          scores.push(scoreRun(task.expect, run));
        }

        results.push({ id: task.id, scores, turns });
      }

      // eslint-disable-next-line no-console
      console.log(formatReport(results, { model: MODEL, trials: TRIALS }));

      // Soft gate: the suite passes as long as it ran. The NUMBERS are the output;
      // we do not fail CI on a low score (this file never runs in CI anyway).
      expect(results.length).toBe(BENCH_TASKS.length);
    },
    20 * 60_000, // up to 20 min for the full matrix on a small local model
  );
});
```

- [ ] **Step 2: Verify it is skipped by default (no Ollama needed)**

Run: `cd extension && npx vitest run tests/bench/run.bench.test.ts`
Expected: PASS with the suite reported as **skipped** (`OLLAMA_BENCH` unset → `describe.skipIf` skips it). No network call is made.

- [ ] **Step 3: Add the npm script**

Modify `extension/package.json` — add `bench` to `scripts` (after `test:watch`):

```json
    "test": "vitest run",
    "test:watch": "vitest",
    "bench": "OLLAMA_BENCH=1 vitest run tests/bench/run.bench.test.ts",
    "typecheck": "tsc --noEmit"
```

- [ ] **Step 4: Document it**

Modify `extension/README.md` — add to the `## Development` code block, after the `npm run build` line:

```bash
npm run bench          # task-success benchmark (needs `ollama serve`; runs the real model)
```

And add a sentence below that block:

```markdown
`npm run bench` runs the real planner→executor→evaluator loop over scripted
multi-page fixtures and reports **completed / correct / grounded** rates. `grounded`
flags answers containing numbers that never appeared on the page — i.e. hallucinations.
Override with `OLLAMA_BENCH_MODEL` / `OLLAMA_BENCH_TRIALS`.
```

- [ ] **Step 5: Full verification — deterministic suite green, types clean**

Run: `cd extension && npx vitest run tests/bench && npm run typecheck`
Expected:
- `fixtures.test.ts`, `scorer.test.ts`, `scripted_browser.test.ts`, `report.test.ts` → PASS.
- `run.bench.test.ts` → skipped.
- `tsc --noEmit` → no errors.

Then confirm the whole project suite still passes:

Run: `cd extension && npm test`
Expected: all existing tests + the 4 new deterministic bench tests PASS; bench runner skipped.

- [ ] **Step 6: Commit**

```bash
git add extension/tests/bench/run.bench.test.ts extension/package.json extension/README.md
git commit -m "feat(bench): live task-success runner + npm run bench"
```

- [ ] **Step 7: Hand off the live run to the user**

The sandbox cannot reach Ollama. Ask the user to run, with `ollama serve` up:

```bash
cd extension && npm run bench
```

Record the printed `completed / correct / grounded` numbers as the **Theme C baseline** — this is the ruler the Theme A (verification & grounding) work will move.

---

## Self-Review

**Spec coverage:**
- Scripted browser + real loop → Task 3 (`scripted_browser.ts`) + Task 5 (runner wires real `Orchestrator`). ✓
- Real model, env-gated, user-run → Task 5 (`describe.skipIf`, `npm run bench`). ✓
- Deterministic scorer: completed/correct/grounded + grounding-as-hallucination-check → Task 2. ✓
- 5 seed tasks incl. the empty/404 anti-hallucination probe → Task 1 (`empty-honesty`). ✓
- Report mirroring `measure_toolcalls` style + N-trial rates → Task 4. ✓
- Deterministic core in `npm test`, runner gated → Tasks 1-4 are `*.test.ts`; Task 5 gated. ✓
- Numbers-grounding skips list markers; profileJson counted as observed → Task 2 (`NUM_RE`) + Task 5 (observedText includes profileJson). ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has expected output. ✓

**Type consistency:** `BenchTask`/`Expectation`/`SearchHit`/`BenchPage`/`Transition` (Task 1) are imported unchanged by Tasks 2/3/5. `Score`/`BenchRun` (Task 2) used by Tasks 4/5. `TaskResult`/`aggregate`/`formatReport` (Task 4) used by Task 5. `ScriptedBrowser`/`buildScriptedRegistry` (Task 3) used by Task 5. `ToolResult`/`ToolContext`/`ToolRegistry` match `src/agent/tools/registry.ts`. `Orchestrator({ollama,registry,settings,emit})` + `start()` + `runUntilTerminal()` match `orchestrator.ts` and the existing integration test. `resetStorage`/`clearHot`/`_setHot` match `tests/helpers.ts` / `state_store.ts`. ✓

All code steps use plain, checked types (`Score[]`, not clever conditional types), so `tsc --noEmit` in Task 5 Step 5 should pass without adjustment.
