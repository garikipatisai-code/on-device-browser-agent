import { describe, expect, it, beforeEach } from 'vitest';
import {
  SEED_WORKFLOWS,
  clearLearnedWorkflows,
  deriveDomain,
  hostFromGoal,
  loadWorkflows,
  markWorkflowTrusted,
  matchWorkflow,
  parseUserRecipe,
  quarantineWorkflow,
  renderRecipe,
  saveWorkflow,
  tokenize,
  traceHasRedundancy,
  traceToWorkflow,
  upsertUserWorkflow,
  type Workflow,
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

  it('prefers a curated (builtin/user) recipe over a learned (auto) one at equal-ish match', () => {
    const builtin: Workflow = { id: 'b', origin: 'builtin', domain: '*', goalKeywords: ['compare', 'population', 'cities'], goalSample: 'compare cities', steps: [{ instruction: 's1' }, { instruction: 's2' }] };
    const auto: Workflow = { id: 'auto:1', origin: 'auto', domain: '*', goalKeywords: ['compare', 'population', 'cities'], goalSample: 'compare cities', steps: [{ instruction: 's1' }, { instruction: 's2' }] };
    const picked = matchWorkflow('compare the population of these cities', [auto, builtin]);
    expect(picked?.id).toBe('b'); // curated wins even though auto scores the same
  });

  it('falls back to a learned (auto) recipe when no curated recipe matches', () => {
    const auto: Workflow = { id: 'auto:2', origin: 'auto', domain: '*', goalKeywords: ['knit', 'scarf', 'pattern'], goalSample: 'knit a scarf', steps: [{ instruction: 's1' }, { instruction: 's2' }] };
    const picked = matchWorkflow('find a knit scarf pattern', [auto]);
    expect(picked?.id).toBe('auto:2');
  });

  it('treats a LEGACY stored recipe (no origin field) as learned, so a builtin archetype still wins', () => {
    // The actual poison in users' stores predates the origin field. It must be demoted, not ranked
    // as curated — otherwise a stale bloated recipe keeps outranking the clean archetype.
    const legacy: Workflow = { id: 'auto:legacy', domain: '*', goalKeywords: ['compare', 'population', 'cities', 'largest'], goalSample: 'compare', steps: [{ instruction: 'bloated a' }, { instruction: 'bloated b' }] };
    const picked = matchWorkflow('compare the population of these cities and tell me which is largest', [...SEED_WORKFLOWS, legacy]);
    expect(picked?.origin).toBe('builtin'); // the clean archetype, NOT the legacy poison
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

  it('every seed recipe is a read-only builtin', () => {
    expect(SEED_WORKFLOWS.every((w) => w.origin === 'builtin')).toBe(true);
  });

  it('has broad+concrete archetypes that match generic goals (not just one phrasing)', () => {
    expect(matchWorkflow('compare the gdp of france, germany and italy', SEED_WORKFLOWS)?.id).toBe('seed-compare');
    expect(matchWorkflow('do deep research on fusion startups and summarize', SEED_WORKFLOWS)?.id).toBe('seed-research');
    expect(matchWorkflow('find a cheap mechanical keyboard under 100 dollars', SEED_WORKFLOWS)?.id).toBe('seed-shopping');
    expect(matchWorkflow('find good italian restaurants near boston', SEED_WORKFLOWS)?.id).toBe('seed-local');
  });

  it('the job recipe attaches the résumé via tab.upload_file and never submits', () => {
    const wf = SEED_WORKFLOWS.find((w) => w.id === 'seed-job-application')!;
    const hints = wf.steps.map((s) => s.toolHint ?? '');
    expect(hints).toContain('tab.upload_file');
    expect(JSON.stringify(wf.steps).toLowerCase()).toContain('do not submit');
    expect(hints.some((h) => h.includes('submit:true'))).toBe(false);
  });
});

describe('renderRecipe', () => {
  it('renders numbered steps with tool hints', () => {
    const text = renderRecipe(SEED_WORKFLOWS.find((w) => w.id === 'seed-onpage-site-search')!);
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

  it('PRESERVES a per-entity loop (search→open ×N) — that repetition is the structure the planner expands', () => {
    // Regression guard: aggressively collapsing the repeated cycle into one occurrence shortened
    // the recipe so much that the planner under-planned a 3-city comparison into a SINGLE step
    // (one combined search → a giant list page → wrong answer). Only consecutive dups collapse;
    // the per-item repetition stays so the planner makes one step per city.
    const perEntity = [
      { tool: 'search', args: { query: 'population of Austin' } },
      { tool: 'open_result', args: { index: 1 } },
      { tool: 'search', args: { query: 'population of Seattle' } },
      { tool: 'open_result', args: { index: 1 } },
      { tool: 'search', args: { query: 'population of Denver' } },
      { tool: 'finish', args: { verdict: 'success', summary: '…' } },
    ];
    const wf = traceToWorkflow('auto:wiki', 'compare the populations of three cities', '*', perEntity);
    expect(wf!.steps.map((s) => s.toolHint)).toEqual(['search', 'open_result', 'search', 'open_result', 'search', 'finish']);
  });

  it('derives the domain from the first opened URL', () => {
    expect(deriveDomain(trace, 'find a mouse')).toBe('amazon.com');
    expect(deriveDomain([], 'go to bestbuy.com')).toBe('bestbuy.com');
  });
});

describe('traceHasRedundancy (a re-search / re-open run is not worth teaching back)', () => {
  it('flags a repeated search query', () => {
    expect(
      traceHasRedundancy([
        { tool: 'search', args: { query: 'Seattle population' } },
        { tool: 'open_result', args: { index: 2 } },
        { tool: 'search', args: { query: 'Seattle population' } }, // same query again
        { tool: 'finish', args: {} },
      ]),
    ).toBe(true);
  });

  it('flags opening the same result URL/index twice', () => {
    expect(
      traceHasRedundancy([
        { tool: 'search', args: { query: 'Seattle' } },
        { tool: 'open_result', args: { index: 1 } },
        { tool: 'open_result', args: { index: 1 } }, // re-open
        { tool: 'finish', args: {} },
      ]),
    ).toBe(true);
  });

  it('does NOT flag a clean per-item run (distinct queries, distinct opens)', () => {
    expect(
      traceHasRedundancy([
        { tool: 'search', args: { query: 'Austin population' } },
        { tool: 'open_result', args: { index: 1 } },
        { tool: 'search', args: { query: 'Seattle population' } },
        { tool: 'open_result', args: { index: 1 } },
        { tool: 'finish', args: {} },
      ]),
    ).toBe(false);
  });
});

describe('clearLearnedWorkflows (forget poisoned auto-recipes; seeds remain)', () => {
  beforeEach(async () => {
    await resetStorage();
  });
  it('removes saved recipes but loadWorkflows still returns the seeds', async () => {
    const wf = traceToWorkflow('auto:x', 'check order status on shopsite.com', 'shopsite.com', [
      { tool: 'tab.open', args: { url: 'https://shopsite.com' } },
      { tool: 'aria.extract', args: { tabId: 1 } },
      { tool: 'finish', args: {} },
    ]);
    await saveWorkflow(wf!);
    expect((await loadWorkflows()).length).toBe(SEED_WORKFLOWS.length + 1);
    await clearLearnedWorkflows();
    expect((await loadWorkflows()).length).toBe(SEED_WORKFLOWS.length); // back to seeds only
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

describe('user recipe authoring (parse guided form + validate)', () => {
  it('parses name / whenToUse / steps (with [tool: x]) into a Workflow and derives keywords', () => {
    const { workflow, errors } = parseUserRecipe({
      name: 'Compare anything',
      whenToUse: 'compare several named things on one metric',
      site: '*',
      stepsText: 'Search one query per item   [tool: search]\nRead the value from the snippet\nReport which wins   [tool: finish]',
    });
    expect(errors).toEqual([]);
    expect(workflow!.origin).toBe('user');
    expect(workflow!.trusted).toBe(false); // new = untrusted until proven
    expect(workflow!.steps).toEqual([
      { instruction: 'Search one query per item', toolHint: 'search' },
      { instruction: 'Read the value from the snippet' },
      { instruction: 'Report which wins', toolHint: 'finish' },
    ]);
    expect(workflow!.goalKeywords).toContain('compare');
    expect(workflow!.whenToUse).toContain('compare');
  });

  it('reports validation errors for an empty name / when-to-use / steps', () => {
    const { workflow, errors } = parseUserRecipe({ name: '', whenToUse: '', site: '', stepsText: '' });
    expect(workflow).toBeNull();
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe('user recipe CRUD + trust/quarantine', () => {
  beforeEach(async () => {
    await resetStorage();
  });
  const mk = (over: Partial<Workflow> = {}): Workflow => ({
    id: 'user:1', origin: 'user', domain: '*', goalKeywords: ['compare', 'cities'], goalSample: 'compare cities',
    whenToUse: 'compare cities', steps: [{ instruction: 'a' }, { instruction: 'b' }], trusted: false, ...over,
  });

  it('upsertUserWorkflow saves a new user recipe (untrusted) and editing a trusted one snapshots last-good', async () => {
    await upsertUserWorkflow(mk());
    let loaded = (await loadWorkflows()).find((w) => w.id === 'user:1')!;
    expect(loaded.origin).toBe('user');
    expect(loaded.trusted).toBe(false);

    // promote to trusted (simulate a clean run), then edit → must snapshot last-good + go untrusted
    await markWorkflowTrusted('user:1');
    await upsertUserWorkflow(mk({ steps: [{ instruction: 'a' }, { instruction: 'b' }, { instruction: 'c-new' }] }));
    loaded = (await loadWorkflows()).find((w) => w.id === 'user:1')!;
    expect(loaded.trusted).toBe(false); // an edit is unproven again
    expect(loaded.lastGood?.steps.length).toBe(2); // the previous good version is snapshotted
    expect(loaded.steps.length).toBe(3);
  });

  it('quarantineWorkflow DELETES a brand-new (no last-good) user recipe on failure', async () => {
    await upsertUserWorkflow(mk());
    const res = await quarantineWorkflow('user:1');
    expect(res).toBe('deleted');
    expect((await loadWorkflows()).some((w) => w.id === 'user:1')).toBe(false);
  });

  it('quarantineWorkflow ROLLS BACK an edited user recipe to its last-good version on failure', async () => {
    await upsertUserWorkflow(mk());
    await markWorkflowTrusted('user:1');
    await upsertUserWorkflow(mk({ steps: [{ instruction: 'a' }, { instruction: 'b' }, { instruction: 'bad-edit' }] }));
    const res = await quarantineWorkflow('user:1');
    expect(res).toBe('rolledback');
    const loaded = (await loadWorkflows()).find((w) => w.id === 'user:1')!;
    expect(loaded.steps.map((s) => s.instruction)).toEqual(['a', 'b']); // back to last-good
    expect(loaded.trusted).toBe(true); // last-good was a proven version
  });

  it('quarantineWorkflow leaves builtin/auto recipes untouched', async () => {
    expect(await quarantineWorkflow('seed-compare')).toBe('ignored');
    expect(await quarantineWorkflow('auto:whatever')).toBe('ignored');
  });
});
