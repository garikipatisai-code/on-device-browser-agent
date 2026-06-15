// Token budgets per role + budget enforcement helpers.
import { TokenRatioEstimator } from './util';
import type { Role } from '@/shared/messages';

// Latency is explicitly deprioritized in favor of long-horizon accuracy, so all
// roles share one large context window. gemma4's sliding-window attention (512-tok
// local windows on e4b, per the model card) keeps the KV-cache cost of this far
// below a naive transformer. Verify the real footprint on the target box with
// `ollama ps`; this can be raised toward 131072 (e4b's 128K max) once VRAM
// headroom is confirmed. Do NOT max it blindly — if KV alloc exceeds VRAM, e4b
// fails to load and every task breaks.
export const NUM_CTX = 32_768;

// Per-role token budgets sit just under NUM_CTX, leaving headroom for generation.
// Kept differentiated (Planner needs the most) but all large now that the 6s
// Executor cap is lifted. Compaction/retrieval still curate the window — a big
// window holding RELEVANT state beats a big window of raw dump (lost-in-the-middle).
export const BUDGETS: Record<Role, number> = {
  planner: 30_000,
  executor: 26_000,
  evaluator: 28_000,
  compactor: 26_000,
};

export const COMPACT_TRIGGER_FRAC = 0.8;

export const CompactionRequired = Symbol('compaction-required');

export interface BudgetCheck {
  tokens: number;
  budget: number;
  overBudget: boolean;
  shouldCompact: boolean;
}

export function checkBudget(role: Role, prompt: string, est: TokenRatioEstimator): BudgetCheck {
  const tokens = est.approxTokens(prompt);
  const budget = BUDGETS[role];
  return {
    tokens,
    budget,
    overBudget: tokens > budget,
    shouldCompact: role === 'executor' && tokens > budget * COMPACT_TRIGGER_FRAC,
  };
}

export function truncateSection(prompt: string, sectionName: string, maxChars: number): string {
  const start = prompt.indexOf(`${sectionName}:`);
  if (start < 0) return prompt;
  const end = prompt.indexOf('\n\n', start + sectionName.length + 1);
  const tail = end < 0 ? '' : prompt.slice(end);
  const head = prompt.slice(0, start);
  return `${head}${sectionName}: [truncated for budget — ${maxChars}ch]\n${tail}`;
}
