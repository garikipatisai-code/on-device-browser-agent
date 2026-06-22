// Agent Workflow Memory (procedural memory) — Phase 1.
//
// Small models re-derive routine multi-step flows from scratch and fumble the
// sequencing. AWM stores known-good *recipes* (generalized tool sequences — NO
// concrete element indices, which are page-specific) and, when the goal matches
// one, injects it into the Planner so the plan mirrors a proven sequence and the
// Executor follows it step-by-step. AWM only ever HELPS: no match → normal planning.
//
// Phase 1 is seed-only (recipes below). Phase 2 auto-records successful runs.

import { memoryGet, memorySet } from '@/background/state_store';
import { redact } from './safety/redact';
import { ulid } from './util';

export interface WorkflowStep {
  instruction: string;
  toolHint?: string;
}

/** Where a recipe came from. 'builtin' = bundled archetype (read-only); 'user' = author-edited
 *  (editable, trust-gated); 'auto' = learned from a clean run (fallback only, demoted in matching). */
export type WorkflowOrigin = 'builtin' | 'user' | 'auto';

export interface Workflow {
  id: string;
  /** Provenance. Defaults to 'auto' for legacy stored recipes that predate this field. */
  origin?: WorkflowOrigin;
  /** Host this recipe is for (e.g. 'amazon.com'), or '*' for any site. */
  domain: string;
  /** Tokens that indicate this recipe is relevant. */
  goalKeywords: string[];
  /** The recipe only matches if the goal contains at least one of these
   *  discriminating tokens — keeps it from hijacking unrelated tasks. */
  requiredAny?: string[];
  goalSample: string;
  /** One plain sentence: when this recipe applies (user-authored; tokenized into goalKeywords). */
  whenToUse?: string;
  steps: WorkflowStep[];
  /** Trust/quarantine (user recipes): false until a clean run proves it. */
  trusted?: boolean;
  /** Snapshot of the last KNOWN-GOOD version (for rollback on a failed edit). */
  lastGood?: { whenToUse?: string; domain: string; steps: WorkflowStep[]; goalKeywords: string[]; requiredAny?: string[] };
}

/** Curated recipes (builtin + user) outrank a learned (auto) one — auto is a fallback only.
 *  Builtins and user recipes ALWAYS set origin, so an undefined origin = a legacy stored recipe
 *  (saved before this field) = learned → ranked as fallback, never as curated. */
function originRank(o?: WorkflowOrigin): number {
  return o === 'builtin' || o === 'user' ? 1 : 0;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'its', 'it', 'with',
  'from', 'into', 'your', 'my', 'this', 'that', 'me', 'please', 'go', 'get', 'is', 'are',
]);

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

const HOST_RE = /\b([a-z0-9-]+\.(?:com|org|net|io|co|gov|edu|in|de|ca|uk))\b/i;
export function hostFromGoal(goal: string): string | null {
  const m = goal.toLowerCase().match(HOST_RE);
  return m ? m[1] : null;
}

export function scoreWorkflow(goalTokens: string[], goalHost: string | null, wf: Workflow): number {
  const tokens = new Set(goalTokens);
  // Gate on discriminating tokens so a recipe can't hijack an unrelated goal.
  if (wf.requiredAny && wf.requiredAny.length && !wf.requiredAny.some((r) => tokens.has(r))) {
    return 0;
  }
  let overlap = 0;
  for (const kw of wf.goalKeywords) if (tokens.has(kw)) overlap += 1;
  const denom = Math.max(1, Math.min(tokens.size, wf.goalKeywords.length));
  let score = overlap / denom;
  if (goalHost && wf.domain !== '*' && (goalHost === wf.domain || goalHost.endsWith('.' + wf.domain))) {
    score += 0.25;
  }
  return score;
}

export function matchWorkflow(goal: string, workflows: Workflow[], threshold = 0.25): Workflow | null {
  const tokens = tokenize(goal);
  const host = hostFromGoal(goal);
  let best: Workflow | null = null;
  let bestScore = 0;
  let bestRank = -1;
  for (const wf of workflows) {
    const s = scoreWorkflow(tokens, host, wf);
    if (s < threshold) continue;
    const rank = originRank(wf.origin);
    // Curated (builtin/user) beats learned (auto). Within the same rank, higher score wins.
    if (rank > bestRank || (rank === bestRank && s > bestScore)) {
      bestRank = rank;
      bestScore = s;
      best = wf;
    }
  }
  return best;
}

export function renderRecipe(wf: Workflow): string {
  return wf.steps
    .map((s, i) => `${i + 1}. ${s.instruction}${s.toolHint ? `  [tool: ${s.toolHint}]` : ''}`)
    .join('\n');
}

/** Map a stored Workflow to the UI-facing RecipeView (friendly fields + the live planner preview).
 *  Imported shape kept local to avoid a messages.ts ↔ workflow_memory.ts import cycle. */
export interface RecipeViewShape {
  id: string;
  origin: WorkflowOrigin;
  name: string;
  whenToUse: string;
  site: string;
  steps: WorkflowStep[];
  trusted?: boolean;
  preview: string;
}
export function toRecipeView(wf: Workflow): RecipeViewShape {
  return {
    id: wf.id,
    origin: wf.origin ?? 'auto',
    name: wf.whenToUse ? wf.id.replace(/^(user:|auto:|seed-)/, '').replace(/[-_]/g, ' ') : wf.goalSample,
    whenToUse: wf.whenToUse ?? wf.goalSample,
    site: wf.domain,
    steps: wf.steps,
    trusted: wf.trusted,
    preview: renderRecipe(wf),
  };
}

/** All recipes (seeds + stored) as UI views, curated first then learned. */
export async function listRecipeViews(): Promise<RecipeViewShape[]> {
  const all = await loadWorkflows();
  return all.map(toRecipeView).sort((a, b) => {
    const rank = (o: WorkflowOrigin) => (o === 'builtin' ? 0 : o === 'user' ? 1 : 2);
    return rank(a.origin) - rank(b.origin);
  });
}

/** Delete a user recipe by id (builtin/auto are not user-deletable here). */
/** Delete a single STORED recipe (learned 'auto' OR user) by id. Builtin seeds are read-only and
 *  aren't in the stored array, so a seed id is a no-op. */
export async function deleteRecipe(id: string): Promise<void> {
  if (id.startsWith('seed-')) return; // builtins are read-only
  const stored = await loadStored();
  await memorySet(STORE_KEY, stored.filter((s) => s.id !== id));
}

export const SEED_WORKFLOWS: Workflow[] = [
  {
    id: 'seed-compare',
    origin: 'builtin',
    domain: '*',
    // BROAD: any comparison of several named things (cities, products, countries, specs…).
    requiredAny: ['compare', 'comparison', 'vs', 'versus', 'largest', 'biggest', 'smallest', 'highest', 'lowest', 'best', 'which'],
    goalKeywords: ['compare', 'comparison', 'versus', 'vs', 'largest', 'biggest', 'smallest', 'highest', 'lowest', 'which', 'population', 'gdp', 'price', 'size', 'cities', 'countries', 'products'],
    goalSample: 'compare several named things on one metric and say which wins',
    whenToUse: 'Comparing several named things (cities, products, countries) on a single metric.',
    steps: [
      { instruction: 'For EACH item, run ONE web search of the form "<item> <metric>" (one item per query — never a combined query, which returns an un-readable ranking page).', toolHint: 'search' },
      { instruction: "Read that item's value straight from the result snippet; open its page only if the snippet lacks the value.", toolHint: 'open_result' },
      { instruction: 'Use the SAME basis for every item (e.g. all city-proper, all 2020 census) — never mix bases.' },
      { instruction: 'Report all items with their values and state which one wins.', toolHint: 'finish' },
    ],
  },
  {
    id: 'seed-research',
    origin: 'builtin',
    domain: '*',
    requiredAny: ['research', 'deep', 'investigate', 'sources'],
    goalKeywords: ['research', 'deep', 'investigate', 'report', 'findings', 'sources', 'topic', 'overview'],
    goalSample: 'research a topic across a few sources and summarize with citations',
    whenToUse: 'Researching a topic and summarizing it from a few sources.',
    steps: [
      { instruction: 'Break the topic into 2–4 concrete sub-questions.' },
      { instruction: 'For each sub-question, run ONE focused web search and read the best result(s) snippet (open a page only when the snippet is thin).', toolHint: 'search' },
      { instruction: 'Synthesize a concise answer from what you actually read; cite the sources.', toolHint: 'finish' },
    ],
  },
  {
    id: 'seed-shopping',
    origin: 'builtin',
    domain: '*',
    requiredAny: ['buy', 'cheap', 'cheapest', 'price', 'deal', 'under', 'shopping', 'product', 'best'],
    goalKeywords: ['buy', 'cheap', 'cheapest', 'price', 'deal', 'under', 'shop', 'shopping', 'product', 'best', 'budget', 'dollars', 'top'],
    goalSample: 'find products matching a category + constraint and report the best few with prices',
    whenToUse: 'Finding products by category and a constraint (e.g. cheapest, under $X).',
    steps: [
      { instruction: 'Search the web for the category plus the constraint (e.g. "mechanical keyboard under $100").', toolHint: 'search' },
      { instruction: 'Read the result snippets / a results page; extract candidate names and prices.', toolHint: 'open_result' },
      { instruction: 'Filter to the constraint and report the top 2–3 with names and prices.', toolHint: 'finish' },
    ],
  },
  {
    id: 'seed-local',
    origin: 'builtin',
    domain: '*',
    requiredAny: ['restaurant', 'restaurants', 'near', 'nearby', 'cafe', 'coffee', 'bar', 'hotel', 'local', 'around'],
    goalKeywords: ['restaurant', 'restaurants', 'near', 'nearby', 'cafe', 'coffee', 'bar', 'hotel', 'local', 'around', 'food', 'place', 'places', 'best'],
    goalSample: 'find local places of a kind near a location and report a few with one detail each',
    whenToUse: 'Finding local places (restaurants, cafes, hotels) near a place.',
    steps: [
      { instruction: 'Search the web for "<kind of place> in <location>".', toolHint: 'search' },
      { instruction: 'Read the result snippets; extract a few place names and one detail each (rating or cuisine). Do NOT invent hours, menus, or addresses.', toolHint: 'open_result' },
      { instruction: 'Report 3–5 places with the detail you actually found.', toolHint: 'finish' },
    ],
  },
  {
    id: 'seed-onpage-site-search',
    origin: 'builtin',
    domain: '*',
    // Triggered by tasks that use a site's OWN search box and drill into a product,
    // e.g. "go to amazon.com, search ... in the search box, click the first product".
    requiredAny: ['box', 'click', 'product'],
    goalKeywords: [
      'search', 'box', 'click', 'product', 'first', 'results', 'result', 'title', 'price',
      'rating', 'buy', 'shop', 'cart', 'site', 'page', 'amazon', 'store', 'listing', 'open',
    ],
    goalSample: 'go to a site, search in its search box, click the first product, report its details',
    steps: [
      { instruction: 'Open the site named in the goal (its homepage).', toolHint: 'tab.open <homepage url>' },
      { instruction: "Read the page and find the site's search box.", toolHint: 'aria.extract' },
      { instruction: 'Type the query from the GOAL into the search box and submit it.', toolHint: 'tab.type submit:true' },
      { instruction: 'Read the search-results page (refreshed automatically after the search).', toolHint: 'aria.extract' },
      { instruction: 'Click the first real product result link.', toolHint: 'tab.click' },
      { instruction: 'Read the product detail page (refreshed automatically after the click).', toolHint: 'aria.extract' },
      { instruction: 'Report the requested fields as the answer (e.g. title, price, rating).', toolHint: 'finish' },
    ],
  },
  {
    id: 'seed-job-application',
    origin: 'builtin',
    domain: '*',
    // Filling + submitting a job application form (an ATS like Greenhouse/Lever).
    requiredAny: ['apply', 'application', 'job'],
    goalKeywords: [
      'apply', 'application', 'job', 'position', 'role', 'resume', 'cv', 'form', 'submit',
      'fill', 'name', 'email', 'candidate', 'greenhouse', 'lever', 'workday', 'careers',
    ],
    goalSample: 'apply to a job: fill the application form from my profile, attach my résumé, and stop before submitting',
    steps: [
      { instruction: 'Open the job application page (from the goal, or open_result of a search).', toolHint: 'tab.open / open_result' },
      { instruction: 'Read the application form and its input fields.', toolHint: 'aria.extract' },
      { instruction: 'Fill each TEXT field by typing the matching value from USER PROFILE (name, email, phone, etc.).', toolHint: 'tab.type' },
      { instruction: 'Attach your résumé to the upload field — it is usually hidden, so use tab.upload_file (do NOT click or index a file input).', toolHint: 'tab.upload_file' },
      { instruction: 'Re-read the form to confirm the fields are filled and the résumé is attached (auto-refreshed after typing).', toolHint: 'aria.extract' },
      { instruction: 'Do NOT submit. Report that the form is filled and ready for the user to review and submit.', toolHint: 'finish' },
    ],
  },
];

// ---- Phase 2: persistence + auto-record successful runs --------------------

const STORE_KEY = 'awm:workflows';
const MAX_STORED = 20;

/** Seeds + everything auto-recorded from past successful runs. */
export async function loadWorkflows(): Promise<Workflow[]> {
  try {
    const raw = await memoryGet(STORE_KEY);
    const stored = Array.isArray(raw) ? (raw as Workflow[]) : [];
    return [...SEED_WORKFLOWS, ...stored];
  } catch {
    return [...SEED_WORKFLOWS];
  }
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  const uni = new Set([...sa, ...sb]).size || 1;
  return inter / uni;
}

/** True if a trace repeated work — searched the same query twice, opened the same URL twice, or
 *  re-opened the same result within one search context. Such a run still answered, but its path is
 *  redundant and must NOT be distilled into a recipe (it would teach the bloat back). open_result
 *  indices are only meaningful relative to their preceding search ("#1" is a different page each
 *  time), so the open-index set resets on every search; only a repeat WITHIN a search counts. */
export function traceHasRedundancy(trace: Array<{ tool: string; args: Record<string, unknown> }>): boolean {
  const seenQueries = new Set<string>();
  const seenUrls = new Set<string>();
  let openIndicesThisSearch = new Set<number>();
  for (const t of trace) {
    if (t.tool === 'search') {
      const q = String((t.args as { query?: unknown }).query ?? '').trim().toLowerCase();
      if (q) {
        if (seenQueries.has(q)) return true;
        seenQueries.add(q);
      }
      openIndicesThisSearch = new Set(); // a fresh search → indices mean something new
    } else if (t.tool === 'open_result') {
      const idx = Number((t.args as { index?: unknown }).index);
      if (Number.isFinite(idx)) {
        if (openIndicesThisSearch.has(idx)) return true;
        openIndicesThisSearch.add(idx);
      }
    } else if (t.tool === 'tab.open') {
      const url = String((t.args as { url?: unknown }).url ?? '').trim().toLowerCase();
      if (url) {
        if (seenUrls.has(url)) return true;
        seenUrls.add(url);
      }
    }
  }
  return false;
}

/** Forget all auto-recorded recipes (the seeds always come back via loadWorkflows). Lets the user
 *  reset a store that accumulated bloated/poisoned recipes so the lean planner rebuilds it clean. */
export async function clearLearnedWorkflows(): Promise<void> {
  await memorySet(STORE_KEY, []);
}

// ---- user recipe authoring + trust/quarantine -----------------------------

/** Parse a known toolHint off the end of a step line: "Do the thing  [tool: search]". */
function parseStepLine(line: string): WorkflowStep | null {
  const text = line.trim();
  if (!text) return null;
  const m = text.match(/\[tool:\s*([^\]]+)\]\s*$/i);
  if (!m) return { instruction: text };
  const instruction = text.slice(0, m.index).trim();
  const toolHint = m[1].trim();
  return instruction ? { instruction, toolHint } : { instruction: text };
}

export interface UserRecipeInput {
  id?: string;
  name: string;
  whenToUse: string;
  site?: string;
  stepsText: string;
}

/** Turn the guided authoring form into a validated user Workflow (origin 'user', untrusted).
 *  Keywords are derived from name + whenToUse so the author never hand-writes a keyword list. */
export function parseUserRecipe(input: UserRecipeInput): { workflow: Workflow | null; errors: string[] } {
  const errors: string[] = [];
  const name = input.name.trim();
  const whenToUse = input.whenToUse.trim();
  const steps = input.stepsText.split('\n').map(parseStepLine).filter((s): s is WorkflowStep => s !== null);
  if (!name) errors.push('Name is required.');
  if (!whenToUse) errors.push('"When to use" is required — one sentence describing when this recipe applies.');
  if (steps.length < 2) errors.push('Add at least 2 steps (one per line).');
  if (errors.length) return { workflow: null, errors };
  const site = (input.site ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '') || '*';
  const workflow: Workflow = {
    id: input.id ?? `user:${ulid()}`,
    origin: 'user',
    domain: site,
    goalKeywords: tokenize(`${name} ${whenToUse}`),
    goalSample: whenToUse,
    whenToUse,
    steps,
    trusted: false,
  };
  return { workflow, errors: [] };
}

/** Read just the stored (non-seed) recipes. */
async function loadStored(): Promise<Workflow[]> {
  try {
    const raw = await memoryGet(STORE_KEY);
    return Array.isArray(raw) ? (raw as Workflow[]) : [];
  } catch {
    return [];
  }
}

/** Insert or update a USER recipe. Editing a currently-TRUSTED recipe snapshots it as last-good and
 *  marks the edit untrusted (it must re-prove itself); a brand-new recipe starts untrusted. */
export async function upsertUserWorkflow(wf: Workflow): Promise<void> {
  const stored = await loadStored();
  const prev = stored.find((s) => s.id === wf.id);
  const next: Workflow = { ...wf, origin: 'user' };
  if (prev && prev.trusted) {
    // editing a proven recipe → keep a rollback target, demote to untrusted
    next.lastGood = { whenToUse: prev.whenToUse, domain: prev.domain, steps: prev.steps, goalKeywords: prev.goalKeywords, requiredAny: prev.requiredAny };
    next.trusted = false;
  } else if (prev && prev.lastGood) {
    next.lastGood = prev.lastGood; // preserve an existing rollback target across further edits
    next.trusted = false;
  }
  const others = stored.filter((s) => s.id !== wf.id);
  others.push(next);
  await memorySet(STORE_KEY, others);
}

/** Mark a stored recipe trusted (called after a clean run that used it) + refresh its last-good. */
export async function markWorkflowTrusted(id: string): Promise<void> {
  const stored = await loadStored();
  const wf = stored.find((s) => s.id === id);
  if (!wf || wf.trusted) return;
  wf.trusted = true;
  wf.lastGood = { whenToUse: wf.whenToUse, domain: wf.domain, steps: wf.steps, goalKeywords: wf.goalKeywords, requiredAny: wf.requiredAny };
  await memorySet(STORE_KEY, stored);
}

export type QuarantineResult = 'deleted' | 'rolledback' | 'ignored';

/** A run that USED a user recipe failed/was messy → make the bad version unusable. A recipe with a
 *  last-good snapshot rolls back to it (a bad edit is undone); one without (brand new, unproven) is
 *  deleted. Builtin/auto recipes are left alone (they're gated elsewhere). */
export async function quarantineWorkflow(id: string): Promise<QuarantineResult> {
  if (!id.startsWith('user:')) return 'ignored';
  const stored = await loadStored();
  const wf = stored.find((s) => s.id === id);
  if (!wf) return 'ignored';
  if (wf.lastGood) {
    const restored: Workflow = {
      ...wf,
      whenToUse: wf.lastGood.whenToUse,
      domain: wf.lastGood.domain,
      steps: wf.lastGood.steps,
      goalKeywords: wf.lastGood.goalKeywords,
      requiredAny: wf.lastGood.requiredAny,
      trusted: true, // last-good was a proven version
    };
    await memorySet(STORE_KEY, stored.map((s) => (s.id === id ? restored : s)));
    return 'rolledback';
  }
  await memorySet(STORE_KEY, stored.filter((s) => s.id !== id));
  return 'deleted';
}

export async function saveWorkflow(wf: Workflow): Promise<void> {
  let stored: Workflow[] = [];
  try {
    const raw = await memoryGet(STORE_KEY);
    if (Array.isArray(raw)) stored = raw as Workflow[];
  } catch {
    /* fresh store */
  }
  // Replace a near-duplicate LEARNED recipe (same domain + very similar keywords) rather than pile
  // up — but NEVER remove a user recipe (saveWorkflow only ever stores auto recipes; a user recipe
  // is curated and must not be clobbered by an auto near-duplicate).
  const deduped = stored.filter(
    (s) => !(s.origin !== 'user' && s.domain === wf.domain && jaccard(s.goalKeywords, wf.goalKeywords) > 0.6),
  );
  deduped.push(wf);
  await memorySet(STORE_KEY, deduped.slice(-MAX_STORED));
}

const TOOL_STEP: Record<string, WorkflowStep | undefined> = {
  'tab.open': { instruction: 'Open the site.', toolHint: 'tab.open' },
  open_result: { instruction: 'Open the chosen search result.', toolHint: 'open_result' },
  search: { instruction: 'Web-search for the target.', toolHint: 'search' },
  'tab.wait_loaded': { instruction: 'Wait for the page to finish loading.', toolHint: 'tab.wait_loaded' },
  'aria.extract': { instruction: 'Read the page.', toolHint: 'aria.extract' },
  'tab.click': { instruction: 'Click the relevant element / result.', toolHint: 'tab.click' },
  'tab.select': { instruction: 'Select the option.', toolHint: 'tab.select' },
  finish: { instruction: 'Report the requested fields as the answer.', toolHint: 'finish' },
  answer: { instruction: 'Report the requested answer.', toolHint: 'finish' },
};

/** Generalize a successful run's tool trace into a reusable recipe (no indices,
 *  query → generic). Returns null if the trace is too trivial to be worth keeping.
 *  Only CONSECUTIVE duplicate hints are collapsed: a per-entity loop (search→open,
 *  search→open, …) is deliberately PRESERVED — that repetition is the structure the
 *  planner expands into one step per item. Collapsing it caused the planner to under-
 *  plan a multi-item goal into a single step; the runtime redundancy (opening a page
 *  when the snippet already answers) is handled by the executor's sufficiency rule. */
export function traceToWorkflow(
  id: string,
  goal: string,
  domain: string,
  trace: Array<{ tool: string; args: Record<string, unknown> }>,
): Workflow | null {
  const steps: WorkflowStep[] = [];
  for (const t of trace) {
    let step: WorkflowStep | undefined;
    if (t.tool === 'tab.type') {
      step = (t.args as { submit?: unknown }).submit
        ? { instruction: 'Type the query into the field and submit it.', toolHint: 'tab.type submit:true' }
        : { instruction: 'Type into the field.', toolHint: 'tab.type' };
    } else {
      step = TOOL_STEP[t.tool];
    }
    if (!step) continue; // skip vision.read / next_step / (none) / echo / scroll noise
    const prev = steps[steps.length - 1];
    if (prev && prev.toolHint === step.toolHint) continue; // collapse consecutive duplicates only
    steps.push(step);
  }
  if (steps.length < 2) return null;
  // Redact PII from the goal before it's persisted to durable memory and re-injected
  // into future planner prompts (job-apply goals routinely carry email/phone/name).
  const safeGoal = redact(goal);
  return { id, origin: 'auto', domain, goalKeywords: tokenize(safeGoal), goalSample: safeGoal, steps };
}

/** Best-effort site host for a trace (first opened URL → host), else from the goal. */
export function deriveDomain(
  trace: Array<{ tool: string; args: Record<string, unknown> }>,
  goal: string,
): string {
  for (const t of trace) {
    const url = (t.args as { url?: unknown }).url;
    if (t.tool === 'tab.open' && typeof url === 'string') {
      try {
        return new URL(url).hostname.replace(/^www\./, '');
      } catch {
        /* not a URL */
      }
    }
  }
  return hostFromGoal(goal) ?? '*';
}
