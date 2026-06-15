import { describe, expect, it, beforeEach } from 'vitest';
import {
  SEED_WORKFLOWS,
  deriveDomain,
  hostFromGoal,
  loadWorkflows,
  matchWorkflow,
  renderRecipe,
  saveWorkflow,
  tokenize,
  traceToWorkflow,
} from '@/agent/workflow_memory';
import { resetStorage } from '../helpers';

describe('tokenize / hostFromGoal', () => {
  it('drops stopwords and short tokens', () => {
    expect(tokenize('Go to the search box')).toEqual(['search', 'box']);
  });
  it('extracts a host from the goal', () => {
    expect(hostFromGoal('Go to amazon.com and search')).toBe('amazon.com');
    expect(hostFromGoal('search for a wireless mouse')).toBeNull();
  });
});

describe('matchWorkflow', () => {
  it('matches the on-page search-box task (the hard one)', () => {
    const goal =
      'Go to amazon.com, search for "wireless mouse" in the page\'s search box, click the first product, and report its title, price, and rating';
    const wf = matchWorkflow(goal, SEED_WORKFLOWS);
    expect(wf?.id).toBe('seed-onpage-site-search');
  });

  it('does NOT hijack the simpler "list top 3" flow (no box/click/product)', () => {
    const goal = 'search amazon for a wireless mouse and list the first 3 results';
    expect(matchWorkflow(goal, SEED_WORKFLOWS)).toBeNull();
  });

  it('does NOT match an unrelated goal', () => {
    expect(matchWorkflow('summarize this news article for me', SEED_WORKFLOWS)).toBeNull();
  });

  it('matches a job-application goal to the ATS recipe', () => {
    const wf = matchWorkflow('apply to the software engineer job and fill the application form', SEED_WORKFLOWS);
    expect(wf?.id).toBe('seed-job-application');
  });
});

describe('renderRecipe', () => {
  it('renders numbered steps with tool hints', () => {
    const text = renderRecipe(SEED_WORKFLOWS[0]);
    expect(text).toMatch(/^1\. /);
    expect(text).toContain('[tool: tab.type submit:true]');
    expect(text).toContain('[tool: finish]');
  });
});

describe('traceToWorkflow (Phase 2 generalization)', () => {
  const trace = [
    { tool: 'tab.open', args: { url: 'https://www.amazon.com' } },
    { tool: 'aria.extract', args: { tabId: 1 } },
    { tool: 'vision.read', args: { tabId: 1 } }, // dropped (noise)
    { tool: 'tab.type', args: { elementIndex: 70, text: 'wireless mouse', submit: true } },
    { tool: 'aria.extract', args: { tabId: 1 } },
    { tool: 'aria.extract', args: { tabId: 1 } }, // collapsed (consecutive dup)
    { tool: 'tab.click', args: { tabId: 1, elementIndex: 125 } },
    { tool: 'finish', args: { verdict: 'success', summary: '...' } },
  ];

  it('generalizes a trace into a recipe (no indices, query removed, noise dropped)', () => {
    const wf = traceToWorkflow('auto:1', 'go to amazon.com and find a wireless mouse', 'amazon.com', trace);
    expect(wf).not.toBeNull();
    const hints = wf!.steps.map((s) => s.toolHint);
    expect(hints).toEqual(['tab.open', 'aria.extract', 'tab.type submit:true', 'aria.extract', 'tab.click', 'finish']);
    const stepsText = JSON.stringify(wf!.steps); // steps must be generalized…
    expect(stepsText).not.toContain('wireless mouse'); // …query generalized away
    expect(stepsText).not.toContain('125'); // …concrete indices dropped
  });

  it('returns null for a trivial trace', () => {
    expect(traceToWorkflow('auto:2', 'g', '*', [{ tool: 'echo', args: {} }, { tool: 'finish', args: {} }])).toBeNull();
  });

  it('derives the domain from the first opened URL', () => {
    expect(deriveDomain(trace, 'find a mouse')).toBe('amazon.com');
    expect(deriveDomain([], 'go to bestbuy.com')).toBe('bestbuy.com');
  });
});

describe('persistence round-trip', () => {
  beforeEach(async () => {
    await resetStorage();
  });
  it('saved workflows are loaded alongside seeds and become matchable', async () => {
    const wf = traceToWorkflow('auto:99', 'check order status on shopsite.com account page', 'shopsite.com', [
      { tool: 'tab.open', args: { url: 'https://shopsite.com' } },
      { tool: 'aria.extract', args: { tabId: 1 } },
      { tool: 'tab.click', args: { tabId: 1, elementIndex: 3 } },
      { tool: 'finish', args: {} },
    ]);
    await saveWorkflow(wf!);
    const all = await loadWorkflows();
    expect(all.length).toBe(SEED_WORKFLOWS.length + 1);
    const matched = matchWorkflow('check my order status on shopsite.com', all);
    expect(matched?.id).toBe('auto:99');
  });
});
