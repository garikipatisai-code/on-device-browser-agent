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
  signal?: AbortSignal;
  timeoutMs?: number;
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
    numCtx: NUM_CTX,
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
      numCtx: NUM_CTX,
    });
    raw = resp.message.content ?? '';
    steps = extractSteps(raw);
  }
  if (steps.length === 0) {
    throw new Error(`Planner returned no usable steps. Raw: ${raw.slice(0, 200)}`);
  }
  // A matched recipe can over-collapse a multi-part goal into a SINGLE step (observed live: a
  // 3-city comparison planned as one "search for all three in sequence" step → one combined search
  // → a giant list page → wrong answer). When a recipe was injected but the plan is a lone step,
  // retry once WITHOUT the recipe, nudging the planner to decompose. Adopt it only if it is
  // genuinely richer, so this can never make the plan worse (or empty).
  if (steps.length === 1 && input.workflowRecipe) {
    const decomposeMessages = [
      ...buildPlannerMessages(input.ctx, input.replanContext), // no recipe this pass
      {
        role: 'user' as const,
        content:
          'That plan has only ONE step, but this goal has several distinct parts. Break it into 3–5 concrete steps — one per item/part (e.g. one step per city or product), ending with a step that reports the answer. Respond with ONLY {"steps":[{"description":"...","successCriteria":"..."}]}.',
      },
    ];
    const r2 = await input.ollama.chatOnce({
      model: input.model,
      messages: decomposeMessages,
      format: 'json',
      thinking: true,
      timeoutMs: input.timeoutMs ?? 300_000,
      signal: input.signal,
      numCtx: NUM_CTX,
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
