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
import type { FlatToolEntry, ParentChildLink } from '@/shared/messages';

interface WorkflowStep {
  instruction: string;
  toolHint?: string;
}

/** Where a recipe came from. 'builtin' = bundled archetype (read-only); 'user' = author-edited
 *  (editable, trust-gated); 'auto' = learned from a clean run (fallback only, demoted in matching). */
type WorkflowOrigin = 'builtin' | 'user' | 'auto';

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
      { instruction: 'Search the FIRST item only: "<item> <metric>" (ONE item per query — never a combined query, which returns an un-readable ranking page). Take its value and NOTE which website that figure came from (its domain) — that site is your ANCHOR SOURCE.', toolHint: 'search' },
      { instruction: 'For EACH remaining item, search "<item> <metric>" and use the figure from the SAME anchor-source website — open that result if the snippet does not show the number. Use a PRECISE number, never a vague range like "over 30 million" or "more than X" — if the anchor\'s snippet is vague, open its page or use the anchor result that states an exact figure. Do NOT take another site\'s number even if it ranks higher or looks bigger: different sites use different bases (e.g. city-proper vs metro population), so mixing them breaks the comparison.', toolHint: 'open_result' },
      { instruction: 'If the anchor source has no figure for an item, switch to ONE website that lists all the items and re-gather every item from it (a consistent set beats saving a step). If no single site covers them all, report each value with its source and say the comparison is approximate.' },
      { instruction: 'Report every item with its value, STATE the source you used and what its figure represents (e.g. "city population, the same site for all"), and say which item wins.', toolHint: 'finish' },
    ],
  },
  {
    id: 'seed-research',
    origin: 'builtin',
    domain: '*',
    // Research/explain/find-info on a topic — guards hallucination + missing citations + over-opening.
    // requiredAny stays a TIGHT gate; goalKeywords is enriched so a gated-in goal scores above the
    // threshold even when it carries extra topic words (recall) — 'about'/'tell' are scorer-only,
    // NOT gate tokens, so "tell me a joke about cats" still doesn't match.
    requiredAny: ['research', 'explain', 'summarize', 'summary', 'overview', 'investigate', 'find', 'recommend', 'learn', 'why', 'causes', 'where'],
    goalKeywords: ['research', 'explain', 'summarize', 'summary', 'overview', 'investigate', 'find', 'recommend', 'learn', 'topic', 'sources', 'why', 'causes', 'where', 'inflation', 'information', 'about', 'tell', 'history', 'effects', 'difference', 'understand', 'meaning'],
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
  {
    id: 'seed-price-compare',
    origin: 'builtin',
    domain: '*',
    // Cheapest place to buy ONE product across sellers — guards list-price-only + variant mismatch.
    // Gate on BUY/shop verbs (not bare 'cheapest', which seed-compare owns) so "which X is cheapest"
    // (different items) still routes to compare, while "where to buy X cheapest" (one item) lands here.
    requiredAny: ['buy', 'purchase', 'sellers', 'seller', 'retailer', 'retailers', 'shop', 'store', 'stores', 'shopping'],
    goalKeywords: ['buy', 'purchase', 'cheapest', 'price', 'prices', 'deal', 'deals', 'sellers', 'seller', 'retailer', 'retailers', 'shop', 'store', 'stores', 'online', 'shipping', 'order', 'where', 'best', 'cost', 'product'],
    goalSample: 'find the cheapest place to buy one specific product across several sellers (compare total incl. shipping)',
    whenToUse: 'Finding the cheapest place to buy ONE specific product across multiple sellers.',
    steps: [
      { instruction: 'Search the EXACT product name (with model/size/variant) on the web.', toolHint: 'search' },
      { instruction: 'Open 2–3 different retailer results for the SAME product variant/condition (open only what you need).', toolHint: 'open_result' },
      { instruction: 'For each seller, read the price AND the shipping cost — compare the TOTAL (price + shipping), never the list price alone, and confirm it is the same variant (size/colour/condition).' },
      { instruction: 'Report each seller with its total and name the cheapest, stating which variant you compared.', toolHint: 'finish' },
    ],
  },
  {
    id: 'seed-cart-stop',
    origin: 'builtin',
    domain: '*',
    // Add to cart / start checkout, STOP before paying — guards auto-purchase (spends real money).
    requiredAny: ['cart', 'checkout', 'basket'],
    goalKeywords: ['cart', 'checkout', 'basket', 'add', 'buy', 'purchase', 'order', 'shop', 'pay', 'payment', 'product', 'item'],
    goalSample: 'add a product to the cart and go to checkout but stop before paying',
    whenToUse: 'Adding items to a cart / starting checkout, stopping before payment.',
    steps: [
      { instruction: 'Open the shopping site / product page (from the goal, or open_result of a search).', toolHint: 'tab.open / open_result' },
      { instruction: 'Read the page, find the product, and add it to the cart.', toolHint: 'tab.click' },
      { instruction: 'Go to the cart / checkout page.', toolHint: 'tab.click' },
      { instruction: 'STOP before any payment, "place order", or purchase-confirm step. Do NOT enter payment details or confirm the order.' },
      { instruction: "Report what's in the cart and that it's ready for the user to review and pay.", toolHint: 'finish' },
    ],
  },
  {
    id: 'seed-pros-cons',
    origin: 'builtin',
    domain: '*',
    // Weigh a decision — guards one-sided / ungrounded opinion. Distinct from verify (true/false).
    requiredAny: ['pros', 'cons', 'advantages', 'disadvantages', 'worth', 'should', 'downside', 'downsides', 'benefits', 'drawbacks', 'tradeoffs'],
    goalKeywords: ['pros', 'cons', 'advantages', 'disadvantages', 'worth', 'should', 'downside', 'downsides', 'benefits', 'drawbacks', 'tradeoffs', 'decision', 'decide', 'buy', 'choose', 'better', 'good', 'bad'],
    goalSample: 'weigh the pros and cons of a decision, grounded in sources, both sides',
    whenToUse: 'Weighing a decision — pros and cons, is it worth it, should I.',
    steps: [
      { instruction: 'Search for BOTH supportive and critical views (e.g. "<topic> benefits" and "<topic> problems / criticism").', toolHint: 'search' },
      { instruction: 'Read a few sources from each side; open a page only if a snippet is too thin.', toolHint: 'open_result' },
      { instruction: 'List the PROS and the CONS separately — each point grounded in something you actually read. Never invent a point and never give only one side.' },
      { instruction: "End with a brief, balanced takeaway (say if it depends on the user's situation) and cite the sources.", toolHint: 'finish' },
    ],
  },
  {
    id: 'seed-find-on-page',
    origin: 'builtin',
    domain: '*',
    // Locate a specific section/mention in the CURRENT tab — guards re-web-searching + whole-page summary.
    // Gate on locate-words (section/mention/part), NOT bare 'find'/'where' (those belong to research).
    requiredAny: ['section', 'sections', 'mention', 'mentions', 'locate', 'paragraph', 'part', 'highlight'],
    goalKeywords: ['section', 'sections', 'mention', 'mentions', 'locate', 'paragraph', 'part', 'highlight', 'page', 'this', 'where', 'find', 'about', 'quote'],
    goalSample: 'find where the current page mentions a specific thing and quote that part',
    whenToUse: 'Locating a specific section / mention within the page the user is on.',
    steps: [
      { instruction: 'Read the page the USER is on with tab.read_active — do NOT web-search or open a new tab.', toolHint: 'tab.read_active' },
      { instruction: 'Scan it for the specific section / term asked about; if the page is long, scroll to load more and read again.', toolHint: 'tab.scroll' },
      { instruction: "Quote or describe the exact part that matches; if it isn't on the page, say so plainly.", toolHint: 'finish' },
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

interface UserRecipeInput {
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

type QuarantineResult = 'deleted' | 'rolledback' | 'ignored';

/** A run that USED a stored (user or auto) recipe failed/was messy → make the bad version unusable.
 *  A USER recipe with a last-good snapshot rolls back to it (a bad edit is undone); one without
 *  (brand new, unproven) is deleted. An AUTO recipe never has a last-good (it's learned, not hand-
 *  edited) — a failed run always deletes it outright: one chance, then it's gone (it can always be
 *  re-learned from a future clean run). Builtin recipes aren't in the stored array at all (they're
 *  seeds), so an unresolvable/builtin id is left alone — 'ignored'. */
export async function quarantineWorkflow(id: string): Promise<QuarantineResult> {
  const stored = await loadStored();
  const wf = stored.find((s) => s.id === id);
  if (!wf || wf.origin === 'builtin') return 'ignored';
  if (wf.origin === 'user' && wf.lastGood) {
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

// ---- T9 flat MCP catalog + parent_child retrieval (BRAIN-only, pure) ----
// T8 debt carried forward (deferred to scheduler, NOT fixed here):
// - T18 bounds recovery-bank retries by RECOVERY_BANK_MAX_ATTEMPTS (no longer maxTurns-only);
// - steerNotes cap-5 eviction is FIFO without priority. See orchestrator notes.

/** True when any `anyOf`/`oneOf` union key appears anywhere in the schema tree. */
export function hasNestedAnyOf(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.some(hasNestedAnyOf);
  if (schema !== null && typeof schema === 'object') {
    const rec = schema as Record<string, unknown>;
    if (Array.isArray(rec.anyOf) || Array.isArray(rec.oneOf)) return true;
    return Object.values(rec).some(hasNestedAnyOf);
  }
  return false;
}

function flattenNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(flattenNode);
  if (node !== null && typeof node === 'object') {
    const rec = node as Record<string, unknown>;
    if (Array.isArray(rec.anyOf) || Array.isArray(rec.oneOf)) {
      // Lean flat MCP: unions (anyOf/oneOf) collapse to string (small-model safe, no nested unions).
      const out: Record<string, unknown> = { type: 'string' };
      if (typeof rec.description === 'string') out.description = rec.description;
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) out[k] = flattenNode(v);
    return out;
  }
  return node;
}

/** Flatten one tool input schema: no `anyOf`/`oneOf` remains anywhere. */
export function flattenJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return flattenNode(schema) as Record<string, unknown>;
}

interface ToolDefLike {
  function: { name: string; description?: string; parameters?: unknown };
}

/** Parent for flat-catalog grouping: page.* + dom.* tools share one anchor. */
export function parentForTool(name: string): string | undefined {
  if (name.startsWith('page.') || name.startsWith('dom.')) return 'page';
  return undefined;
}

/** Flatten a registry `toolDefs()` array into small-model-safe entries. */
export function flattenToolCatalog(defs: ToolDefLike[]): FlatToolEntry[] {
  return defs.map((d) => {
    const params =
      d.function.parameters !== null && typeof d.function.parameters === 'object'
        ? flattenJsonSchema(d.function.parameters as Record<string, unknown>)
        : {};
    const entry: FlatToolEntry = {
      name: d.function.name,
      description: d.function.description ?? '',
      parameters: params,
    };
    const parent = parentForTool(d.function.name);
    if (parent) entry.parent = parent;
    return entry;
  });
}

// ---- T4 hybrid retrieval stub (RRF + FLAT_FALLBACK, binary-MRL-512) ----------
// T10: RRF K=60 pinned, MRL-256 prefix Hamming + full rescore, cascade cutoff
// (pure stub, no model).

/** RRF fusion constant (pinned: changing it reorders every fused ranking). */
export const RRF_K = 60;

/** MRL-256 prefix length in bytes (first 256 bits of the 512-bit vector). */
export const MRL_PREFIX_BYTES = 32;

/** Default cascade prefilter width (MRL-256 cheap pass). */
export const CASCADE_PREFILTER_TOPK = 5;

/** Default cascade score cutoff (pure score filter, no model). */
export const CASCADE_SCORE_CUTOFF = 0.02;

/** Fallback mode marker: keyword-only linear scan (no usable query vector). */
export const FLAT_FALLBACK = 'FLAT_FALLBACK' as const;
export type HybridRetrievalMode = 'RRF' | typeof FLAT_FALLBACK;

export interface HybridQuery {
  text: string;
  vec512?: Uint8Array;
  topK?: number;
}

/** Default recall bound (ScaleMCP top-k). */
export const DEFAULT_TOPK = 5;

/** Clamp a topK param: bad (undefined/≤0/NaN/non-finite) → default 5, else floor. */
export function normalizeTopK(topK?: number): number {
  if (!Number.isFinite(topK as number) || (topK as number) <= 0) return DEFAULT_TOPK;
  return Math.floor(topK as number);
}

export interface HybridHit {
  anchor: string;
  summary: string;
  score: number;
  mode: HybridRetrievalMode;
}

interface HybridDoc {
  anchor: string;
  summary: string;
  vec512: Uint8Array;
}

function isBinaryMrl512(v: unknown): v is Uint8Array {
  return v instanceof Uint8Array && v.length === 64;
}

function popcountByte(b: number): number {
  let x = b & 0xff;
  let c = 0;
  while (x) {
    c += x & 1;
    x >>= 1;
  }
  return c;
}

function hamming64(a: Uint8Array, b: Uint8Array): number {
  let d = 0;
  for (let i = 0; i < 64; i++) d += popcountByte(a[i] ^ b[i]);
  return d;
}

/** Full-vector Hamming distance (equal-length binary vectors). */
export function hammingDistance(a: Uint8Array, b: Uint8Array): number {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) throw new Error('vectors must be Uint8Array');
  if (a.length !== b.length) throw new Error('vectors must be equal length');
  let d = 0;
  for (let i = 0; i < a.length; i++) d += popcountByte(a[i] ^ b[i]);
  return d;
}

/** MRL-256 prefix Hamming: first 32 bytes (256 bits) only. */
export function hammingDistance256(a: Uint8Array, b: Uint8Array): number {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) throw new Error('vectors must be Uint8Array');
  if (a.length < MRL_PREFIX_BYTES || b.length < MRL_PREFIX_BYTES) throw new Error('vectors too short for MRL-256 prefix');
  let d = 0;
  for (let i = 0; i < MRL_PREFIX_BYTES; i++) d += popcountByte(a[i] ^ b[i]);
  return d;
}

/** Pure cascade score cutoff (stub, no model): keep hits at/above cutoff, order preserved. */
export function cascadeCutoff(hits: HybridHit[], cutoff: number = CASCADE_SCORE_CUTOFF): HybridHit[] {
  if (!Array.isArray(hits)) return [];
  if (!Number.isFinite(cutoff)) return [...hits];
  return hits.filter((h) => h.score >= cutoff);
}

function keywordOverlap(queryText: string, summary: string): number {
  const q = new Set(tokenize(queryText));
  let overlap = 0;
  for (const t of tokenize(summary)) if (q.has(t)) overlap += 1;
  return overlap;
}

/** Minimal hybrid retriever: RRF fusion of keyword + binary-vector ranks,
 *  flat keyword linear scan when no usable query vector is supplied.
 *  T9 parent_child: index chunks via indexChild, queries return the PARENT
 *  anchor (deduped, best-score wins). FLAT_FALLBACK mode is preserved. */
export class HybridRetriever {
  private docs: HybridDoc[] = [];
  private childToParent = new Map<string, string>();
  private parentSummaries = new Map<string, string>();

  index(anchor: string, summary: string, vec512: Uint8Array): void {
    if (!isBinaryMrl512(vec512)) throw new Error('vec512 must be Uint8Array(64)');
    this.docs.push({ anchor, summary, vec512: new Uint8Array(vec512) });
    this.parentSummaries.set(anchor, summary);
  }

  /** Index a child chunk under a parent anchor. Query hits on the child
   *  resolve to the parent anchor (parent summary kept when the parent was
   *  indexed, else the matching chunk summary). */
  indexChild(parentAnchor: string, childAnchor: string, summary: string, vec512: Uint8Array): void {
    if (!isBinaryMrl512(vec512)) throw new Error('vec512 must be Uint8Array(64)');
    const link: ParentChildLink = { parent: parentAnchor, child: childAnchor };
    this.docs.push({ anchor: link.child, summary, vec512: new Uint8Array(vec512) });
    this.childToParent.set(link.child, link.parent);
  }

  private resolveParents(hits: HybridHit[]): HybridHit[] {
    const seen = new Set<string>();
    const out: HybridHit[] = [];
    for (const h of hits) {
      const parent = this.childToParent.get(h.anchor) ?? h.anchor;
      if (seen.has(parent)) continue;
      seen.add(parent);
      if (parent === h.anchor) {
        out.push(h);
        continue;
      }
      // Child hit → parent anchor with the parent summary when the parent was
      // indexed, else the matching chunk summary.
      out.push({ ...h, anchor: parent, summary: this.parentSummaries.get(parent) ?? h.summary });
    }
    return out;
  }

  query(q: HybridQuery): HybridHit[] {
    const topK = normalizeTopK(q.topK);
    if (this.docs.length === 0) return [];
    // Flat fallback: keyword-only linear scan.
    if (!isBinaryMrl512(q.vec512)) {
      const ranked = this.docs
        .map((d, i) => ({ d, i, s: keywordOverlap(q.text, d.summary) }))
        .sort((a, b) => b.s - a.s || a.i - b.i)
        .map(({ d, s }) => ({ anchor: d.anchor, summary: d.summary, score: s, mode: FLAT_FALLBACK as HybridRetrievalMode }));
      return this.resolveParents(ranked).slice(0, topK);
    }
    const qv = q.vec512;
    const kwRanked = this.docs
      .map((d, i) => ({ d, i, s: keywordOverlap(q.text, d.summary) }))
      .sort((a, b) => b.s - a.s || a.i - b.i);
    const vecRanked = this.docs
      .map((d, i) => ({ d, i, dist: hamming64(qv, d.vec512) }))
      .sort((a, b) => a.dist - b.dist || a.i - b.i);
    const K = RRF_K;
    const fused = new Map<HybridDoc, number>();
    kwRanked.forEach((r, rank) => fused.set(r.d, (fused.get(r.d) ?? 0) + 1 / (K + rank + 1)));
    vecRanked.forEach((r, rank) => fused.set(r.d, (fused.get(r.d) ?? 0) + 1 / (K + rank + 1)));
    const distByDoc = new Map<HybridDoc, number>(vecRanked.map((r) => [r.d, r.dist]));
    const ranked = [...fused.entries()]
      .map(([d, score]) => ({ anchor: d.anchor, summary: d.summary, score, dist: distByDoc.get(d) ?? 0, mode: 'RRF' as HybridRetrievalMode }))
      // Full-vector rescore order: RRF score first, then full Hamming distance.
      .sort((a, b) => b.score - a.score || a.dist - b.dist)
      .map(({ anchor, summary, score, mode }) => ({ anchor, summary, score, mode }));
    return this.resolveParents(ranked).slice(0, topK);
  }

  /** Thin top-k seam: same ranking as query, explicit bound (clamped). */
  queryTopK(q: HybridQuery, topK?: number): HybridHit[] {
    return this.query({ ...q, topK: topK !== undefined ? topK : q.topK });
  }

  /** T10 cascade: MRL-256 prefix prefilter → full-vector rescore → RRF fusion → score cutoff.
   *  Pure stub (no model): deterministic, sync, 0 LLM calls.
   *  NOTE: zero production call-sites as of T10 — intentional stub; wiring deferred to scheduler. */
  queryCascade(q: HybridQuery, prefilterTopK: number = CASCADE_PREFILTER_TOPK, cutoff: number = CASCADE_SCORE_CUTOFF): HybridHit[] {
    const topK = normalizeTopK(q.topK);
    if (this.docs.length === 0) return [];
    if (!isBinaryMrl512(q.vec512)) {
      const ranked = this.docs
        .map((d, i) => ({ d, i, s: keywordOverlap(q.text, d.summary) }))
        .sort((a, b) => b.s - a.s || a.i - b.i)
        .map(({ d, s }) => ({ anchor: d.anchor, summary: d.summary, score: s, mode: FLAT_FALLBACK as HybridRetrievalMode }));
      return cascadeCutoff(this.resolveParents(ranked), cutoff).slice(0, topK);
    }
    const qv = q.vec512;
    // Cheap MRL-256 pass: keep the closest prefilterTopK by prefix Hamming.
    const preK = normalizeTopK(prefilterTopK);
    const preRanked = this.docs
      .map((d, i) => ({ d, i, dist: hammingDistance256(qv, d.vec512) }))
      .sort((a, b) => a.dist - b.dist || a.i - b.i)
      .slice(0, preK);
    const shortlist = new Set(preRanked.map((r) => r.d));
    // Full-vector rescore on the shortlist only.
    const vecRanked = preRanked
      .map((r) => ({ d: r.d, i: r.i, dist: hamming64(qv, r.d.vec512) }))
      .sort((a, b) => a.dist - b.dist || a.i - b.i);
    const kwRanked = this.docs
      .map((d, i) => ({ d, i, s: keywordOverlap(q.text, d.summary) }))
      .filter((r) => shortlist.has(r.d))
      .sort((a, b) => b.s - a.s || a.i - b.i);
    const fused = new Map<HybridDoc, number>();
    kwRanked.forEach((r, rank) => fused.set(r.d, (fused.get(r.d) ?? 0) + 1 / (RRF_K + rank + 1)));
    vecRanked.forEach((r, rank) => fused.set(r.d, (fused.get(r.d) ?? 0) + 1 / (RRF_K + rank + 1)));
    const distByDoc = new Map<HybridDoc, number>(vecRanked.map((r) => [r.d, r.dist]));
    const ranked = [...fused.entries()]
      .map(([d, score]) => ({ anchor: d.anchor, summary: d.summary, score, dist: distByDoc.get(d) ?? 0, mode: 'RRF' as HybridRetrievalMode }))
      .sort((a, b) => b.score - a.score || a.dist - b.dist)
      .map(({ anchor, summary, score, mode }) => ({ anchor, summary, score, mode }));
    return cascadeCutoff(this.resolveParents(ranked), cutoff).slice(0, topK);
  }
}

// ---- T19 threaded recall (BRAIN-only, pure) --------------------------------
// Single threaded entry for the scheduler's future call-site: threads topK →
// normalizeTopK, MRL-256 prefilter → full rescore → RRF-60 fusion → cutoff →
// parent-dedupe → slice in one call. Thin delegate over queryCascade (same
// ranking, no fork) — mirrors the queryTopK seam. 0 LLM calls (pure stub).
// NOTE: zero production call-sites as of T19 — intentional seam; wiring
// deferred to scheduler (same as the T10 cascade / T16 DAG notes).

/** Threaded recall: same ranking as queryCascade, bounds threaded through. */
export function retrieveThreaded(
  r: HybridRetriever,
  q: HybridQuery,
  prefilterTopK: number = CASCADE_PREFILTER_TOPK,
  cutoff: number = CASCADE_SCORE_CUTOFF,
): HybridHit[] {
  return r.queryCascade(q, prefilterTopK, cutoff);
}

// ---- T14 top-k caller wiring (BRAIN-only, pure) ----------------------------
// The planner caller path renders the single best recipe today (matchWorkflow +
// renderRecipe in the orchestrator). This seam threads an explicit top-k recall
// through the SAME scoring so a future caller can render a bounded set.
// Omitting topK recalls DEFAULT_TOPK (byte-identical to passing 5); a bad topK
// (<=0/NaN/non-finite) clamps the same way via normalizeTopK. The existing
// single-match sequential path (matchWorkflow) is untouched below.

/** Ranked top-k recall for a goal: same order as matchWorkflow (curated rank
 *  first, then score), so index [0] is the sequential single match. */
export function matchWorkflows(
  goal: string,
  workflows: Workflow[],
  topK: number = DEFAULT_TOPK,
  threshold = 0.25,
): Workflow[] {
  const tokens = tokenize(goal);
  const host = hostFromGoal(goal);
  return workflows
    .map((wf, i) => ({ wf, i, s: scoreWorkflow(tokens, host, wf), rank: originRank(wf.origin) }))
    .filter((r) => r.s >= threshold)
    .sort((a, b) => b.rank - a.rank || b.s - a.s || a.i - b.i)
    .slice(0, normalizeTopK(topK))
    .map((r) => r.wf);
}

/** Bounded caller render: top-k matched recipes for the planner prompt, each via
 *  renderRecipe. `undefined` when nothing matches (same convention as the
 *  single-recipe `workflowRecipe` slot). */
export function renderTopRecipes(
  goal: string,
  workflows: Workflow[],
  topK: number = DEFAULT_TOPK,
): string | undefined {
  const matches = matchWorkflows(goal, workflows, topK);
  if (matches.length === 0) return undefined;
  return matches.map(renderRecipe).join('\n---\n');
}

// ---- T8 PALADIN recovery bank (BRAIN-only, pure) ----------------------------
//
// Evaluator FAILs with recognizable error signatures get a single-step steer
// fix (zero replans) instead of burning a full planner replan. Unknown
// signatures return null so the caller falls back to backtrack → replan.

export interface RecoveryEntry {
  /** Lowercase substring matched against the (lowercased) FAIL reason. */
  pattern: string;
  /** Single short steer instruction (<1 step: no replan, no multi-part plan). */
  fix: string;
}

/** T18 bank-attempt bound (BRAIN-only, pure): dedicated per-run budget for
 *  recovery-bank steer fixes — the bank no longer retries until maxTurns.
 *  Width 2 mirrors the backtrack width-2 retry (cheap fix, then fall through
 *  to backtrack → replan). */
export const RECOVERY_BANK_MAX_ATTEMPTS = 2;

export const RECOVERY_BANK: RecoveryEntry[] = [
  { pattern: 'aria.extract returned empty', fix: 'Re-read the page with aria.extract once more; if still empty, report the field as not shown — never invent it.' },
  { pattern: 'aria.extract timed out', fix: 'Wait for the tab to settle, then re-read once; act on the fresh page instead of retrying blindly.' },
  { pattern: 'vision.read returned blank', fix: 'Re-read with vision.read after the page settles; report only what is actually visible in the vision image.' },
  { pattern: 'element is no longer attached', fix: 'Re-read the page to refresh element indices, then click the new index — never reuse a stale index.' },
  { pattern: 'element not clickable', fix: 'Scroll the element into view, then click once; if still blocked, use the nearest visible link instead.' },
  { pattern: 'click index out of range', fix: 'Re-read the page for fresh indices and click the correct new index for the same target.' },
  { pattern: 'type target field not found', fix: 'Re-read the page to find the input field, then type into the fresh index.' },
  { pattern: 'field is readonly', fix: 'The field is readonly — do not type into it; read its displayed value and continue.' },
  { pattern: 'select option not found', fix: 'Re-read the dropdown and pick the closest matching option text exactly as shown.' },
  { pattern: 'no file chosen', fix: 'Attach the résumé via tab.upload_file with the stored file path — never click a hidden file input.' },
  { pattern: 'blocked url', fix: 'The domain is blocked by tiers — stay on an allowed domain and answer from what was already read.' },
  { pattern: 'invalid scheme', fix: 'Use an http(s) page URL for navigation — chrome/file schemes can never be opened.' },
  { pattern: 'navigation timeout', fix: 'Wait for the tab to settle and re-read once before acting further.' },
  { pattern: 'no active tab', fix: 'Open the target page first, then read it — there is no tab to act on yet.' },
  { pattern: 'reached end of page', fix: 'Report what was collected so far and say the list may be partial — do not loop further.' },
  { pattern: 'search returned no results', fix: 'Simplify the search query to fewer distinctive words and search once more.' },
  { pattern: 'search query was empty', fix: 'Build a concrete query from the goal terms and search once.' },
  { pattern: 'search rate limited', fix: 'Wait briefly, then retry the same search once with the same query.' },
  { pattern: 'open_result index out of range', fix: 'Run the web search again to refresh results, then open a valid index.' },
  { pattern: 'no prior search', fix: 'Run a web search first, then open one of its results.' },
  { pattern: 'consent overlay', fix: 'Dismiss the consent overlay once, then read the real page content.' },
  { pattern: 'captcha wall', fix: 'Pause and ask the human to resolve the check — never attempt to solve it.' },
  { pattern: 'read-only domain', fix: 'This is a read-only domain — read and report only, never click or type here.' },
  { pattern: 'click requires upgrade', fix: 'Clicking needs a domain upgrade — read what is visible and report instead.' },
  { pattern: 'blocked scheme', fix: 'That URL scheme cannot be opened — use an http(s) page instead.' },
  { pattern: 'ungrounded number', fix: 'Report only numbers exactly as grounded in the observations — never estimate.' },
  { pattern: 'field reported absent', fix: 'Re-answer from the full corpus of earlier reads before claiming a field is missing.' },
  { pattern: 'wrong page', fix: 'Go back to the earlier known-good page and try a different link from there.' },
  { pattern: 'list incomplete', fix: 'Scroll or open the next page to capture the rest, then report every item.' },
  { pattern: 'mixed comparison basis', fix: 'Re-gather every item from the same anchor source — never mix site bases.' },
  { pattern: 'vague range', fix: 'Replace the vague range with the precise figure exactly as the source states it.' },
  { pattern: 'hallucinated phone', fix: 'Report only contact fields exactly as shown on the page; mark the rest not shown.' },
  { pattern: 'no citation', fix: 'Cite the specific sources used for each reported fact.' },
  { pattern: 'prose answer not grounded', fix: 'Answer again using only values grounded in the observations already gathered.' },
  { pattern: 'not in workspace', fix: 'Answer from the workspace observations already saved — do not open new tabs.' },
  { pattern: 'repeated same tool call', fix: 'Stop repeating the call — try a different tool or method for this step.' },
  { pattern: 'unknown tool loop', fix: 'Use only tools from the tool catalog — check the catalog names and retry.' },
  { pattern: 'no tool call', fix: 'Emit one concrete tool call for the current step now.' },
  { pattern: 'aria.extract back-to-back', fix: 'Act on the page just read instead of re-extracting it.' },
  { pattern: 'plan has no steps', fix: 'Replan into concrete steps from the goal — one step per page or query.' },
  { pattern: 'replan limit', fix: 'Salvage the best partial answer from the corpus instead of replanning.' },
  { pattern: 'no such tab', fix: 'Open the page again to get a live tab, then continue from there.' },
  { pattern: 'network error fetching', fix: 'Retry the same read once — transient network errors usually clear.' },
  { pattern: 'page still loading', fix: 'Wait for the tab to settle, then re-read the fresh page.' },
  { pattern: 'workspace entry missing', fix: 'Save the read to the workspace first, then cite the saved entry.' },
  { pattern: 'scratchpad overflow', fix: 'Continue from the compacted scratchpad summary — do not re-read gathered pages.' },
  { pattern: 'blocked but facts gathered', fix: 'Salvage the answer from the facts already gathered and report it.' },
  { pattern: 'failed but answer in corpus', fix: 'Answer from the corpus of earlier reads instead of giving up.' },
  { pattern: 'login required', fix: 'Stop and ask the human to log in — never attempt credentials yourself.' },
  { pattern: 'subscribe to read', fix: 'Report the snippet content as a partial answer and note the rest is paywalled.' },
  { pattern: 'submit button not found', fix: 'Re-read the form to locate the submit control, then proceed.' },
  { pattern: 'file input is hidden', fix: 'Use tab.upload_file for the hidden input — never click it directly.' },
  { pattern: 'rating graphic with no number', fix: 'Report the rating as not shown — a graphic without a number is unreadable.' },
  { pattern: 'table too large', fix: 'Find the specific row asked for and report only that row.' },
  { pattern: 'computed mentally', fix: 'Search the web for the conversion value instead of computing it.' },
];

/** First bank entry whose pattern appears in the reason (case-insensitive), else null. */
export function lookupRecovery(reason: string): RecoveryEntry | null {
  const hay = (reason ?? '').toLowerCase();
  if (!hay) return null;
  for (const entry of RECOVERY_BANK) {
    if (hay.includes(entry.pattern)) return entry;
  }
  return null;
}
