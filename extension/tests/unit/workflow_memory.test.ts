import { describe, expect, it, beforeEach } from 'vitest';
import {
  SEED_WORKFLOWS,
  clearLearnedWorkflows,
  deleteRecipe,
  deriveDomain,
  hostFromGoal,
  loadWorkflows,
  markWorkflowTrusted,
  matchWorkflow,
  parseUserRecipe,
  quarantineWorkflow,
  renderRecipe,
  saveWorkflow,
  scoreWorkflow,
  tokenize,
  traceHasRedundancy,
  traceToWorkflow,
  traceWorthLearning,
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
    expect(matchWorkflow('tell me a joke about cats', SEED_WORKFLOWS)).toBeNull();
  });

  it('matches a job-application goal to the ATS recipe', () => {
    const wf = matchWorkflow('apply to the software engineer job and fill the application form', SEED_WORKFLOWS);
    expect(wf?.id).toBe('seed-job-application');
  });

  it('every seed recipe is a read-only builtin', () => {
    expect(SEED_WORKFLOWS.every((w) => w.origin === 'builtin')).toBe(true);
  });

  it('each capability archetype matches its task kind (and they are distinct)', () => {
    expect(matchWorkflow('compare the gdp of france, germany and italy', SEED_WORKFLOWS)?.id).toBe('seed-compare');
    expect(matchWorkflow('which laptop has the best battery life', SEED_WORKFLOWS)?.id).toBe('seed-compare'); // ranking/shopping folds in
    expect(matchWorkflow('research what causes inflation and explain it', SEED_WORKFLOWS)?.id).toBe('seed-research');
    expect(matchWorkflow('report the price, rating and stock of the Studio headphones', SEED_WORKFLOWS)?.id).toBe('seed-extract');
    expect(matchWorkflow('summarize this page for me', SEED_WORKFLOWS)?.id).toBe('seed-ask-page');
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

  it('generalizes learned-recipe match keywords: keeps task words, drops instance entities', () => {
    const wf = traceToWorkflow(
      'auto:g',
      'Using Wikipedia, compare the populations of Austin, Seattle, and Denver — which is largest?',
      '*',
      [{ tool: 'search', args: {} }, { tool: 'open_result', args: { index: 1 } }],
    );
    // task words survive → the recipe matches ANY such comparison…
    expect(wf!.goalKeywords).toContain('compare');
    expect(wf!.goalKeywords).toContain('populations');
    // …but the specific entities are stripped, so it isn't bound to those three cities/that source
    expect(wf!.goalKeywords).not.toContain('austin');
    expect(wf!.goalKeywords).not.toContain('seattle');
    expect(wf!.goalKeywords).not.toContain('denver');
    expect(wf!.goalKeywords).not.toContain('wikipedia');
  });

  it('a generalized learned recipe matches a DIFFERENT instance of the same task', () => {
    const wf = traceToWorkflow('auto:cmp', 'compare the populations of Austin, Seattle, and Denver', '*', [
      { tool: 'search', args: {} }, { tool: 'open_result', args: { index: 1 } },
    ])!;
    // a brand-new comparison goal (different cities) should still score above threshold
    const score = scoreWorkflow(tokenize('compare the populations of Chicago, Houston, and Phoenix'), null, wf);
    expect(score).toBeGreaterThan(0.25);
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

describe('traceWorthLearning (skip trivial lookups, learn real procedures)', () => {
  it('is FALSE for a pure search-and-report lookup (no navigation)', () => {
    expect(traceWorthLearning([{ tool: 'search', args: {} }, { tool: 'finish', args: {} }])).toBe(false);
    expect(traceWorthLearning([{ tool: 'search', args: {} }, { tool: 'search', args: {} }, { tool: 'finish', args: {} }])).toBe(false);
    expect(traceWorthLearning([{ tool: 'aria.extract', args: {} }, { tool: 'finish', args: {} }])).toBe(false);
  });
  it('is TRUE when the run navigated or interacted with a page', () => {
    expect(traceWorthLearning([{ tool: 'search', args: {} }, { tool: 'open_result', args: { index: 1 } }, { tool: 'finish', args: {} }])).toBe(true);
    expect(traceWorthLearning([{ tool: 'tab.open', args: {} }, { tool: 'tab.type', args: {} }, { tool: 'finish', args: {} }])).toBe(true);
  });
});

describe('clearLearnedWorkflows (forget poisoned auto-recipes; seeds remain)', () => {
  beforeEach(async () => {
    await resetStorage();
  });
  it('deleteRecipe removes a single learned (auto) recipe by id, leaving others + seeds', async () => {
    const a = traceToWorkflow('auto:keep', 'find a knit scarf pattern online', '*', [
      { tool: 'search', args: { query: 'knit scarf' } }, { tool: 'open_result', args: { index: 1 } },
    ]);
    const b = traceToWorkflow('auto:gone', 'check order status on shopsite.com', 'shopsite.com', [
      { tool: 'tab.open', args: { url: 'https://shopsite.com' } }, { tool: 'aria.extract', args: { tabId: 1 } },
    ]);
    await saveWorkflow(a!);
    await saveWorkflow(b!);
    await deleteRecipe('auto:gone');
    const ids = (await loadWorkflows()).map((w) => w.id);
    expect(ids).toContain('auto:keep');
    expect(ids).not.toContain('auto:gone');
    expect(ids).toContain('seed-compare'); // builtin seeds untouched
  });
  it('deleteRecipe refuses to delete a builtin seed (no-op)', async () => {
    await deleteRecipe('seed-compare');
    expect((await loadWorkflows()).some((w) => w.id === 'seed-compare')).toBe(true);
  });
});

describe('clearLearnedWorkflows (forget poisoned auto-recipes; seeds remain) — legacy alias', () => {
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

describe('saveWorkflow never clobbers a user recipe (auto dedup is auto-only)', () => {
  beforeEach(async () => {
    await resetStorage();
  });
  it('keeps a near-duplicate USER recipe when an auto recipe is saved', async () => {
    await upsertUserWorkflow({ id: 'user:keep', origin: 'user', domain: '*', goalKeywords: ['compare', 'cities', 'population'], goalSample: 'compare cities', whenToUse: 'compare cities', steps: [{ instruction: 'a' }, { instruction: 'b' }], trusted: true });
    const auto = traceToWorkflow('auto:dup', 'compare cities population', '*', [{ tool: 'search', args: {} }, { tool: 'open_result', args: { index: 1 } }]);
    await saveWorkflow(auto!);
    const ids = (await loadWorkflows()).map((w) => w.id);
    expect(ids).toContain('user:keep'); // protected — an auto save must never remove a user recipe
    expect(ids).toContain('auto:dup');
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
