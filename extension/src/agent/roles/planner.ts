// Planner role.
import type { ModelProvider } from '../framework/provider';
import { newPlan } from '../plan';
import type { Plan } from '@/shared/messages';
import { parseJSONPermissive } from '../util';
import { buildPlannerMessages, type CommonContext } from '../prompts';
import { NUM_CTX } from '../budget';

export interface PlannerInput {
  ctx: CommonContext;
  model: string;
  ollama: ModelProvider;
  replanContext?: string;
  workflowRecipe?: string;
  /** Step count of the matched recipe (if any). Used to detect an under-planned/collapsed plan. */
  recipeStepCount?: number;
  /** True once the recipe-parity retry (below) has already fired once for this task — from EITHER
   *  a prior runPlanner call on this task or an earlier attempt within this same call. When true,
   *  a collapsed plan is returned as-is rather than retried again. This is what bounds the retry to
   *  once per task even though the orchestrator's outer replan() loop can call runPlanner up to
   *  `maxReplans` times — each of those calls would otherwise re-trigger this same internal retry. */
  recipeRetryUsed?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  numCtx?: number;
}

export interface PlannerOutput {
  plan: Plan;
  raw: string;
  promptEvalCount?: number;
  evalCount?: number;
  /** True iff the recipe-parity retry actually fired on this call (regardless of whether the
   *  richer plan was adopted). The caller (orchestrator) persists this onto the shared per-task
   *  hot state (`recipeRetryUsed`) so it is never fired again for the same task. */
  retryFired?: boolean;
  /** True iff the planner signaled GOAL isn't actionable ({"noGoal":true}). `plan` is a throwaway
   *  empty plan in this case — the orchestrator must check this BEFORE using `plan` at all. */
  noGoal?: boolean;
}

interface RawPlan {
  steps?: Array<{
    description?: string;
    successCriteria?: string;
    toolHint?: string;
  }>;
  /** The planner's explicit signal that GOAL isn't an actionable task — see the prompt in
   *  prompts/index.ts. Distinct from an empty/malformed steps array (which still retries). */
  noGoal?: boolean;
}

function parseRawPlan(raw: string): RawPlan | null {
  return parseJSONPermissive<RawPlan>(raw);
}

function extractSteps(parsed: RawPlan | null): Array<{ description: string; successCriteria?: string; toolHint?: string }> {
  return (parsed?.steps ?? [])
    .filter((s) => typeof s?.description === 'string')
    .map((s) => ({ description: s.description!, successCriteria: s.successCriteria, toolHint: s.toolHint }));
}

export async function runPlanner(input: PlannerInput): Promise<PlannerOutput> {
  const messages = buildPlannerMessages(input.ctx, input.replanContext, input.workflowRecipe);
  let resp = await input.ollama.chatOnce({
    model: input.model,
    messages,
    format: 'json',
    thinking: true,
    timeoutMs: input.timeoutMs ?? 300_000,
    signal: input.signal,
    numCtx: input.numCtx ?? NUM_CTX,
  });
  let raw = resp.message.content ?? '';
  let parsed = parseRawPlan(raw);
  if (parsed?.noGoal === true) {
    return { plan: newPlan([]), raw, noGoal: true, promptEvalCount: resp.promptEvalCount, evalCount: resp.evalCount };
  }
  let steps = extractSteps(parsed);
  if (steps.length === 0) {
    // A small model occasionally emits a wrong-shaped or empty plan even under format:json
    // (e.g. {"plan":[...]} or {}). Retry once with an explicit shape reminder before aborting the
    // whole task — the executor already gets a retry; the planner shouldn't be the brittle link.
    const retryMessages = [
      ...messages,
      {
        role: 'user' as const,
        content:
          'That was not a usable plan. Respond with ONLY {"steps":[{"description":"...","successCriteria":"..."}]} containing at least one concrete step.',
      },
    ];
    resp = await input.ollama.chatOnce({
      model: input.model,
      messages: retryMessages,
      format: 'json',
      thinking: true,
      timeoutMs: input.timeoutMs ?? 300_000,
      signal: input.signal,
      numCtx: input.numCtx ?? NUM_CTX,
    });
    raw = resp.message.content ?? '';
    parsed = parseRawPlan(raw);
    if (parsed?.noGoal === true) {
      return { plan: newPlan([]), raw, noGoal: true, promptEvalCount: resp.promptEvalCount, evalCount: resp.evalCount };
    }
    steps = extractSteps(parsed);
  }
  if (steps.length === 0) {
    throw new Error(`Planner returned no usable steps. Raw: ${raw.slice(0, 200)}`);
  }
  // A matched recipe can over-collapse a task into too few steps (observed live: a 3-step contact
  // recipe planned as ONE mis-scoped "search" step → garbled evaluation → stall; and a multi-city
  // comparison planned as one combined search). When a recipe was injected but the plan has FEWER
  // steps than the recipe (or is a lone step), retry once — KEEPING the recipe — nudging the planner
  // to produce one step per recipe step (expanding any "for each item" step per named item). Adopt
  // only if genuinely richer, so this can never make the plan worse (or empty).
  //
  // Bounded to once per TASK (not once per runPlanner call): the orchestrator's outer replan() loop
  // calls runPlanner again from scratch on evaluator FAIL, up to maxReplans times — each of those
  // calls would otherwise re-trigger this same collapsed-plan condition. `recipeRetryUsed` is the
  // orchestrator's shared per-task memory of "this retry already happened once"; skip it here if so.
  const recipeCount = input.recipeStepCount;
  const collapsed =
    !input.recipeRetryUsed &&
    !!input.workflowRecipe &&
    (steps.length === 1 || (recipeCount != null && steps.length < recipeCount));
  let retryFired = false;
  if (collapsed) {
    retryFired = true;
    const m = recipeCount ?? steps.length;
    const parityMessages = [
      ...buildPlannerMessages(input.ctx, input.replanContext, input.workflowRecipe), // KEEP the recipe
      {
        role: 'user' as const,
        content:
          `Your plan has ${steps.length} step(s)${recipeCount ? `, but the recipe lists ${m}` : ''}. Produce ONE plan step per recipe step, in order — and expand any "for each item" step into one step per named item in the goal. Each step's successCriteria must state what is TRUE when that step is done (e.g. "the page shows the requested info"), not the action taken. Respond with ONLY {"steps":[{"description":"...","successCriteria":"..."}]}.`,
      },
    ];
    const r2 = await input.ollama.chatOnce({
      model: input.model,
      messages: parityMessages,
      format: 'json',
      thinking: true,
      timeoutMs: input.timeoutMs ?? 300_000,
      signal: input.signal,
      numCtx: input.numCtx ?? NUM_CTX,
    });
    const s2 = extractSteps(parseRawPlan(r2.message.content ?? ''));
    if (s2.length > steps.length) {
      steps = s2;
      raw = r2.message.content ?? '';
      resp = r2;
    }
  }
  const plan = newPlan(
    steps.map((s) => ({
      description: s.description,
      // `||` not `??`: a model-emitted empty-string criterion would otherwise reach the evaluator
      // prompt as "SUCCESS CRITERIA: " and yield a vacuous judgment.
      successCriteria: s.successCriteria || `Step ${s.description} achieved`,
      toolHint: s.toolHint,
    })),
  );
  return {
    plan,
    raw,
    promptEvalCount: resp.promptEvalCount,
    evalCount: resp.evalCount,
    retryFired,
  };
}
