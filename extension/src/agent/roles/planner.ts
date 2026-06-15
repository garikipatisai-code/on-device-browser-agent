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

export async function runPlanner(input: PlannerInput): Promise<PlannerOutput> {
  const messages = buildPlannerMessages(input.ctx, input.replanContext, input.workflowRecipe);
  const resp = await input.ollama.chatOnce({
    model: input.model,
    messages,
    format: 'json',
    thinking: true,
    timeoutMs: input.timeoutMs ?? 300_000,
    signal: input.signal,
    numCtx: NUM_CTX,
  });
  const raw = resp.message.content ?? '';
  const parsed = parseJSONPermissive<RawPlan>(raw);
  const steps = (parsed?.steps ?? []).filter((s) => typeof s?.description === 'string');
  if (steps.length === 0) {
    throw new Error(`Planner returned no usable steps. Raw: ${raw.slice(0, 200)}`);
  }
  const plan = newPlan(
    steps.map((s) => ({
      description: s.description!,
      successCriteria: s.successCriteria ?? `Step ${s.description} achieved`,
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
