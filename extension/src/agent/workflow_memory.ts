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

/** Like tokenize, but for LEARNED recipes: strip instance-specific entities so the recipe matches
 *  the TASK kind, not one goal. Removes quoted phrases, standalone numbers, and proper-noun words
 *  (Capitalized, non-sentence-initial — e.g. "Austin", "Wikipedia"), keeping task words (compare,
 *  populations, find, price). Keeps tokenize's punctuation splitting so hosts like "shopsite.com"
 *  still become matchable tokens. */
export function generalizeGoalKeywords(goal: string): string[] {
  const stripped = goal
    .replace(/["'“”‘’][^"'“”‘’]*["'“”‘’]/g, ' ') // quoted phrases (specific values)
    .replace(/\b\d[\d,.]*\b/g, ' '); // standalone numbers
  const kept = stripped
    .split(/\s+/)
    .map((w, i) => {
      const lead = w.replace(/^[^A-Za-z]+/, ''); // ignore leading punctuation for the capital test
      return i > 0 && /^[A-Z][a-z]/.test(lead) ? ' ' : w; // drop a proper noun (not sentence-initial)
    })
    .join(' ');
  return tokenize(kept);
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
    // Comparison/ranking of several named things — guards basis-mixing + the combined-query list trap.
    requiredAny: ['compare', 'comparison', 'vs', 'versus', 'largest', 'biggest', 'smallest', 'highest', 'lowest', 'best', 'most', 'cheapest', 'top', 'which', 'rank'],
    goalKeywords: ['compare', 'comparison', 'versus', 'largest', 'biggest', 'smallest', 'highest', 'lowest', 'best', 'cheapest', 'most', 'top', 'which', 'rank', 'population', 'gdp', 'price', 'size', 'battery', 'laptop', 'cities', 'countries', 'products'],
    goalSample: 'compare or rank several named things on one metric and say which wins',
    whenToUse: 'Comparing or ranking several named things (which is largest / best / cheapest).',
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
    // Research/explain/find-info on a topic — guards hallucination + missing citations + over-opening.
    requiredAny: ['research', 'explain', 'summarize', 'summary', 'overview', 'investigate', 'find', 'recommend', 'learn', 'why', 'causes', 'where'],
    goalKeywords: ['research', 'explain', 'summarize', 'summary', 'overview', 'investigate', 'find', 'recommend', 'learn', 'topic', 'sources', 'why', 'causes', 'where', 'inflation'],
    goalSample: 'research / explain / find information on a topic and answer with sources',
    whenToUse: 'Researching, explaining, or finding information on a topic from the web.',
    steps: [
      { instruction: 'Break the topic into 2–4 concrete sub-questions.' },
      { instruction: "For each sub-question, run ONE focused web search and read the best results' snippets; open a page only when the snippet is too thin.", toolHint: 'search' },
      { instruction: 'Synthesize a concise answer from ONLY what you actually read — never invent a fact, number, or name.' },
      { instruction: 'Cite the specific sources you used.', toolHint: 'finish' },
    ],
  },
  {
    id: 'seed-extract',
    origin: 'builtin',
    domain: '*',
    // Report specific fields of a product/page — guards absent-field hallucination + giant tables.
    requiredAny: ['price', 'rating', 'stock', 'specs', 'spec', 'details', 'cost', 'weight', 'dimensions', 'availability', 'review', 'reviews'],
    goalKeywords: ['price', 'rating', 'stock', 'specs', 'details', 'cost', 'weight', 'dimensions', 'availability', 'review', 'reviews', 'report', 'value'],
    goalSample: 'report specific fields (price, rating, stock, specs) of a product or page',
    whenToUse: 'Reporting specific fields (price, rating, stock, specs) of a product or page.',
    steps: [
      { instruction: 'Open the product/page (from a search result, or the exact URL given).', toolHint: 'open_result' },
      { instruction: 'Read the page; report ONLY the requested fields that actually appear as TEXT in the content.', toolHint: 'aria.extract' },
      { instruction: 'A field shown only as a graphic/icon (e.g. a star rating with no number, or an image) is NOT readable — report it as "not shown" and NEVER guess a value.' },
      { instruction: 'If the data is in a large table, find the SPECIFIC row/cell asked for — do not summarize the whole table. Report the values.', toolHint: 'finish' },
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
  {
    id: 'seed-ask-page',
    origin: 'builtin',
    domain: '*',
    // Answer about the user's CURRENT tab — guards web-searching when they mean the open page.
    requiredAny: ['summarize', 'summary', 'page', 'current', 'say'],
    goalKeywords: ['summarize', 'summary', 'page', 'current', 'read', 'say', 'content', 'article'],
    goalSample: 'summarize or answer a question about the page the user is currently on',
    whenToUse: 'Answering about the page the user is currently on (summarize this page, what does it say).',
    steps: [
      { instruction: 'Read the page the USER is currently on with tab.read_active — their active tab, on-device. Do NOT open a new tab or web-search.', toolHint: 'tab.read_active' },
      { instruction: 'Answer ONLY from what that page says; if the answer is not on the page, say so.', toolHint: 'finish' },
    ],
  },
  {
    id: 'seed-verify',
    origin: 'builtin',
    domain: '*',
    // Fact-check a claim — guards stating unverified things + one-source bias.
    requiredAny: ['verify', 'true', 'fact', 'confirm', 'accurate', 'debunk', 'myth', 'really', 'claim', 'hoax', 'whether'],
    goalKeywords: ['verify', 'true', 'fact', 'confirm', 'accurate', 'debunk', 'myth', 'really', 'claim', 'hoax', 'whether', 'check'],
    goalSample: 'verify whether a claim is true, using independent sources',
    whenToUse: 'Fact-checking a claim — is it true? Reports supported / contradicted / unclear.',
    steps: [
      { instruction: 'Search the web for the exact claim.', toolHint: 'search' },
      { instruction: 'Read 2–3 INDEPENDENT sources (not all the same site); open a page only if a snippet is too thin.', toolHint: 'open_result' },
      { instruction: 'Judge the claim against what those sources actually say: SUPPORTED, CONTRADICTED, or UNCLEAR. If sources disagree, say so — never assert beyond the evidence.' },
      { instruction: 'Report the verdict with the supporting evidence and the sources.', toolHint: 'finish' },
    ],
  },
  {
    id: 'seed-live-value',
    origin: 'builtin',
    domain: '*',
    // Current/fast-changing value — guards reciting a stale value from memory.
    requiredAny: ['current', 'today', 'now', 'price', 'weather', 'stock', 'score', 'live', 'latest', 'temperature', 'forecast'],
    goalKeywords: ['current', 'today', 'now', 'price', 'weather', 'stock', 'score', 'live', 'latest', 'temperature', 'forecast', 'cost', 'rate', 'available'],
    goalSample: 'look up a current, fast-changing value (price, weather, score) right now',
    whenToUse: 'Looking up a current / live value (price, weather, score, stock).',
    steps: [
      { instruction: 'Search the web for the CURRENT value (put "current"/"today" in the query).', toolHint: 'search' },
      { instruction: 'Prefer the official/primary source. For a fast-changing value (price, stock, score, weather) OPEN the page to confirm — never trust a possibly-cached snippet or your own memory.', toolHint: 'open_result' },
      { instruction: 'Report the value WITH its as-of time/date and source, and note it can change.', toolHint: 'finish' },
    ],
  },
  {
    id: 'seed-howto',
    origin: 'builtin',
    domain: '*',
    // Steps to do something — guards inventing plausible-but-wrong steps.
    requiredAny: ['how', 'steps', 'guide', 'tutorial', 'instructions', 'setup', 'install', 'configure', 'tips', 'fix'],
    goalKeywords: ['how', 'steps', 'guide', 'tutorial', 'instructions', 'setup', 'install', 'configure', 'tips', 'fix', 'create', 'build', 'make'],
    goalSample: 'find and report the steps to do something, from a guide',
    whenToUse: 'How to do something — report the steps from a guide.',
    steps: [
      { instruction: 'Search the web for a reputable how-to / guide for the task.', toolHint: 'search' },
      { instruction: 'Read the best guide (open it if the snippet is too short to hold the full steps).', toolHint: 'open_result' },
      { instruction: 'Report the steps IN ORDER, exactly as the source gives them (numbered); do NOT invent steps the source did not state. Cite the guide.', toolHint: 'finish' },
    ],
  },
  {
    id: 'seed-collect-list',
    origin: 'builtin',
    domain: '*',
    // Enumerate a complete list — guards list truncation / losing rows.
    requiredAny: ['list', 'all', 'every', 'each', 'collect', 'enumerate'],
    goalKeywords: ['list', 'all', 'every', 'each', 'collect', 'enumerate', 'top', 'names', 'items', 'results'],
    goalSample: 'extract a complete list of items from a page or results',
    whenToUse: 'Collecting a complete list of items (every product, link, name) from a page or results.',
    steps: [
      { instruction: 'Open the page or results that hold the list.', toolHint: 'open_result' },
      { instruction: 'Read it and enumerate EVERY matching item — not just the first few.', toolHint: 'aria.extract' },
      { instruction: 'If the list is long or paginated, scroll (or open the next page) to capture the rest before reporting.', toolHint: 'tab.scroll' },
      { instruction: 'Report the complete list as a structured list (item + its key fields). If you could not get them all, say how many you captured.', toolHint: 'finish' },
    ],
  },
  {
    id: 'seed-convert',
    origin: 'builtin',
    domain: '*',
    // Convert/calculate — guards the 4B's unreliable arithmetic by looking the value up.
    requiredAny: ['convert', 'calculate', 'conversion', 'exchange', 'percent', 'percentage', 'much', 'many'],
    goalKeywords: ['convert', 'calculate', 'conversion', 'exchange', 'rate', 'percent', 'percentage', 'much', 'many', 'dollars', 'euros', 'pounds', 'usd', 'eur', 'currency', 'miles', 'kilometers', 'celsius', 'fahrenheit'],
    goalSample: 'convert or calculate a value by looking it up (currency, units, percentages)',
    whenToUse: 'Converting or calculating a value (currency, units, percentages, math) — look it up, do not compute.',
    steps: [
      { instruction: 'Search the web for the conversion/calculation itself (e.g. "100 USD to EUR", "15 percent of 240", "5 miles in km").', toolHint: 'search' },
      { instruction: 'Read the answer from the calculator/converter result in the snippet. Do NOT compute it yourself — small models get arithmetic, rates, and unit conversions wrong.' },
      { instruction: 'Report the value; for currency, include the exchange rate and its date.', toolHint: 'finish' },
    ],
  },
  {
    id: 'seed-contact',
    origin: 'builtin',
    domain: '*',
    // Business contact info — guards fabricated phone/email/address/hours.
    requiredAny: ['phone', 'email', 'address', 'hours', 'contact', 'number', 'directions'],
    goalKeywords: ['phone', 'email', 'address', 'hours', 'contact', 'number', 'directions', 'location', 'reach', 'open'],
    goalSample: "find a business's contact details from its official source",
    whenToUse: "Finding a business's contact info (phone, email, address, hours).",
    steps: [
      { instruction: 'Search for the business, then open its OFFICIAL source (its own website, or a reputable directory).', toolHint: 'open_result' },
      { instruction: 'Report only the contact fields that actually appear on the page. Mark any requested field that is not shown as "not listed".' },
      { instruction: 'NEVER invent a phone number, email, address, or hours — report only what the page states.', toolHint: 'finish' },
    ],
  },
  {
    id: 'seed-read-visual',
    origin: 'builtin',
    domain: '*',
    // Read a chart/image the ARIA tree can't — surfaces the under-used vision.read capability.
    requiredAny: ['chart', 'image', 'screenshot', 'graph', 'infographic', 'picture', 'diagram', 'visual', 'photo'],
    goalKeywords: ['chart', 'image', 'screenshot', 'graph', 'infographic', 'picture', 'diagram', 'visual', 'photo', 'show', 'shows', 'depicts', 'read'],
    goalSample: 'read a chart/image/screenshot the accessibility tree cannot',
    whenToUse: 'Reading a chart, image, or canvas the accessibility tree cannot (uses vision).',
    steps: [
      { instruction: 'Read the page with aria.extract first.', toolHint: 'aria.extract' },
      { instruction: 'If aria.extract returns almost nothing (a canvas, image, or chart with no text), call vision.read on that tab to read it from a screenshot.', toolHint: 'vision.read' },
      { instruction: 'Report ONLY what is actually visible in the image — do not invent labels, numbers, or trends.', toolHint: 'finish' },
    ],
  },
  {
    id: 'seed-translate',
    origin: 'builtin',
    domain: '*',
    // Translate the current tab — distinct, on-device, current-tab.
    requiredAny: ['translate', 'translation', 'english', 'spanish', 'french', 'german', 'japanese', 'chinese', 'language'],
    goalKeywords: ['translate', 'translation', 'english', 'spanish', 'french', 'german', 'japanese', 'chinese', 'language', 'page', 'say', 'meaning'],
    goalSample: 'translate the current page into a target language',
    whenToUse: 'Translating the page the user is on into a target language.',
    steps: [
      { instruction: 'Read the page the USER is on with tab.read_active — their active tab, on-device. Do NOT open a new tab or web-search.', toolHint: 'tab.read_active' },
      { instruction: "Translate ONLY the page's actual text into the requested language; do not add commentary or summarize unless asked.", toolHint: 'finish' },
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

// Tools that mean the run did real browser WORK (navigated/interacted) — not just a lookup.
const LEARNABLE_TOOLS = new Set(['open_result', 'tab.open', 'tab.click', 'tab.type', 'tab.select', 'tab.upload_file']);

/** Worth distilling into a recipe? Only a run that NAVIGATED or INTERACTED with a page — a real
 *  multi-step procedure. A pure search-and-report lookup ("capital of France") is trivial: the model
 *  plans it fine unaided, so a learned recipe adds clutter with no benefit. */
export function traceWorthLearning(trace: Array<{ tool: string; args: Record<string, unknown> }>): boolean {
  return trace.some((t) => LEARNABLE_TOOLS.has(t.tool));
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
  // Match on the TASK shape, not the instance: drop proper-noun entities (Austin), quoted phrases,
  // and numbers so a learned recipe generalizes to the same KIND of task — not just this one goal.
  return { id, origin: 'auto', domain, goalKeywords: generalizeGoalKeywords(safeGoal), goalSample: safeGoal, steps };
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
