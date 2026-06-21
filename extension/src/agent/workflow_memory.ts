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

export interface WorkflowStep {
  instruction: string;
  toolHint?: string;
}

export interface Workflow {
  id: string;
  /** Host this recipe is for (e.g. 'amazon.com'), or '*' for any site. */
  domain: string;
  /** Tokens that indicate this recipe is relevant. */
  goalKeywords: string[];
  /** The recipe only matches if the goal contains at least one of these
   *  discriminating tokens — keeps it from hijacking unrelated tasks. */
  requiredAny?: string[];
  goalSample: string;
  steps: WorkflowStep[];
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
  for (const wf of workflows) {
    const s = scoreWorkflow(tokens, host, wf);
    if (s > bestScore) {
      bestScore = s;
      best = wf;
    }
  }
  return bestScore >= threshold ? best : null;
}

export function renderRecipe(wf: Workflow): string {
  return wf.steps
    .map((s, i) => `${i + 1}. ${s.instruction}${s.toolHint ? `  [tool: ${s.toolHint}]` : ''}`)
    .join('\n');
}

export const SEED_WORKFLOWS: Workflow[] = [
  {
    id: 'seed-onpage-site-search',
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

export async function saveWorkflow(wf: Workflow): Promise<void> {
  let stored: Workflow[] = [];
  try {
    const raw = await memoryGet(STORE_KEY);
    if (Array.isArray(raw)) stored = raw as Workflow[];
  } catch {
    /* fresh store */
  }
  // Replace a near-duplicate (same domain + very similar keywords) rather than pile up.
  const deduped = stored.filter((s) => !(s.domain === wf.domain && jaccard(s.goalKeywords, wf.goalKeywords) > 0.6));
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

/** Collapse immediately-repeated action cycles into a single occurrence. A per-entity
 *  loop (search→open, search→open, search→open) is a 2-step cycle repeated N times; it
 *  should be stored ONCE — recipes are generalized planner HINTS, and the planner re-expands
 *  the loop for the actual goal's items. Subsumes consecutive-duplicate collapse (a 1-step
 *  cycle), so non-repeating sequences are left exactly as-is. */
function collapseRepeatedCycles(steps: WorkflowStep[]): WorkflowStep[] {
  const key = (s: WorkflowStep) => s.toolHint ?? s.instruction;
  const out = steps.slice();
  let changed = true;
  while (changed) {
    changed = false;
    for (let size = 1; size * 2 <= out.length && !changed; size++) {
      for (let i = 0; i + 2 * size <= out.length; i++) {
        let equal = true;
        for (let k = 0; k < size; k++) {
          if (key(out[i + k]) !== key(out[i + size + k])) {
            equal = false;
            break;
          }
        }
        if (equal) {
          out.splice(i + size, size); // drop the immediate repetition
          changed = true;
          break;
        }
      }
    }
  }
  return out;
}

/** Generalize a successful run's tool trace into a reusable recipe (no indices,
 *  query → generic). Returns null if the trace is too trivial to be worth keeping. */
export function traceToWorkflow(
  id: string,
  goal: string,
  domain: string,
  trace: Array<{ tool: string; args: Record<string, unknown> }>,
): Workflow | null {
  const raw: WorkflowStep[] = [];
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
    raw.push(step);
  }
  // Collapse repeated action cycles (per-entity loops + consecutive dups) so the recipe stores
  // the PATTERN once instead of replaying it — the redundancy fix for auto-distilled recipes.
  const steps = collapseRepeatedCycles(raw);
  if (steps.length < 2) return null;
  // Redact PII from the goal before it's persisted to durable memory and re-injected
  // into future planner prompts (job-apply goals routinely carry email/phone/name).
  const safeGoal = redact(goal);
  return { id, domain, goalKeywords: tokenize(safeGoal), goalSample: safeGoal, steps };
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
