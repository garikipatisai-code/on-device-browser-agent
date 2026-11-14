// Token budgets per role + budget enforcement helpers.
import { TokenRatioEstimator } from './util';
import type { Role } from '@/shared/messages';

// Latency is explicitly deprioritized in favor of long-horizon accuracy, so all
// roles share one large context window. gemma4's sliding-window attention (512-tok
// local windows on e4b, per the model card) keeps the KV-cache cost of this far
// below a naive transformer. Verify the real footprint on the target box with
// `ollama ps`; num_ctx is user-configurable up to MAX_NUM_CTX (e4b's 128K max) once
// VRAM headroom is confirmed. Do NOT max it blindly — if KV alloc exceeds VRAM, e4b
// fails to load and every task breaks.
export const DEFAULT_NUM_CTX = 32_768;
export const MIN_NUM_CTX = 8_192;
export const MAX_NUM_CTX = 131_072; // e4b's 128K ceiling
/** Back-compat default for callers that don't thread the setting. */
export const NUM_CTX = DEFAULT_NUM_CTX;

/** Clamp a user-supplied window to a safe range; falls back to the proven default. */
export function clampNumCtx(n: number | undefined): number {
  if (!n || !Number.isFinite(n)) return DEFAULT_NUM_CTX;
  return Math.max(MIN_NUM_CTX, Math.min(MAX_NUM_CTX, Math.round(n)));
}

// Per-role token budgets sit just under num_ctx, leaving headroom for generation.
// Kept differentiated (Planner needs the most). Budgets scale with the window so a
// bigger num_ctx coherently widens the curated state (a big window holding RELEVANT
// state beats a big window of raw dump — lost-in-the-middle).
export function budgetsFor(numCtx: number, limitedResources = false): Record<Role, number> {
  const scale = numCtx / DEFAULT_NUM_CTX;
  const planner = Math.round(30_000 * scale);
  const executor = Math.round(26_000 * scale);
  const evaluator = Math.round(28_000 * scale);
  const compactor = Math.round(26_000 * scale);
  // Off path is byte-identical to the baseline — no cap applied.
  if (!limitedResources) return { planner, executor, evaluator, compactor };
  // On: hard 4K cap on every role budget.
  return {
    planner: Math.min(planner, 4_096),
    executor: Math.min(executor, 4_096),
    evaluator: Math.min(evaluator, 4_096),
    compactor: Math.min(compactor, 4_096),
  };
}

/** Raw working-memory caps (chars). CROSS-TURN memory (scratch + observed) scales with the window;
 *  the PER-READ page cap stays FIXED — the ARIA tool caps extraction at this size, and a 4B reads a
 *  single page more accurately in a focused chunk than a sprawling one (lost-in-the-middle). A bigger
 *  window's value for long multi-step tasks is remembering MORE across turns, not larger single reads. */
export function capsFor(
  numCtx: number,
  limitedResources = false,
): { page: number; scratch: number; observed: number; salvage: number } {
  const scale = numCtx / DEFAULT_NUM_CTX;
  const page = 12_000;
  const scratch = Math.round(12_000 * scale);
  const observed = Math.round(60_000 * scale);
  const salvage = Math.round(24_000 * scale);
  // Off path is byte-identical to the baseline — page stays fixed, cross-turn caps scale.
  if (!limitedResources) return { page, scratch, observed, salvage };
  // On: page fixed by design; cross-turn caps hard-limited to 4K chars.
  return {
    page,
    scratch: Math.min(scratch, 4_096),
    observed: Math.min(observed, 4_096),
    salvage: Math.min(salvage, 4_096),
  };
}

export const COMPACT_TRIGGER_FRAC = 0.8;

export interface BudgetCheck {
  tokens: number;
  budget: number;
  overBudget: boolean;
  shouldCompact: boolean;
}

export function checkBudget(
  role: Role,
  prompt: string,
  est: TokenRatioEstimator,
  numCtx: number = DEFAULT_NUM_CTX,
  limitedResources = false,
): BudgetCheck {
  const tokens = est.approxTokens(prompt);
  const budget = budgetsFor(numCtx, limitedResources)[role];
  return {
    tokens,
    budget,
    overBudget: tokens > budget,
    shouldCompact: role === 'executor' && tokens > budget * COMPACT_TRIGGER_FRAC,
  };
}
