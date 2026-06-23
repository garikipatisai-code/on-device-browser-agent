// Planner role.
import type { OllamaClient } from '@/background/ollama';
import { newPlan } from '../plan';
import type { Plan } from '@/shared/messages';
import { parseJSONPermissive } from '../util';
import { buildPlannerMessages, type CommonContext } from '../prompts';
import { NUM_CTX } from '../budget';

export interface PlannerInput {
  ctx: CommonContext;
  model: string;
  ollama: OllamaClient;
  replanContext?: string;
  workflowRecipe?: string;
  /** Step count of the matched recipe (if any). Used to detect an under-planned/collapsed plan. */
  recipeStepCount?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  numCtx?: number;
}

export interface PlannerOutput {
  plan: Plan;
  raw: string;
  promptEvalCount?: number;
  evalCount?: number;
}

interface RawPlan {
  steps?: Array<{
    description?: string;
    successCriteria?: string;
    toolHint?: string;
  }>;
}

function extractSteps(raw: string): Array<{ description: string; successCriteria?: string; toolHint?: string }> {
  const parsed = parseJSONPermissive<RawPlan>(raw);
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
  let steps = extractSteps(raw);
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
    steps = extractSteps(raw);
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
  const recipeCount = input.recipeStepCount;
  const collapsed =
    !!input.workflowRecipe && (steps.length === 1 || (recipeCount != null && steps.length < recipeCount));
  if (collapsed) {
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
    const s2 = extractSteps(r2.message.content ?? '');
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
  };
}
