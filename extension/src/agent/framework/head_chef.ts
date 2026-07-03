// The head chef seat: decides the plan. Wraps roles/planner.ts unchanged —
// message-building, retry, and recipe-parity logic all stay exactly as they
// are; only the model backend becomes swappable.
import { runPlanner, type PlannerInput, type PlannerOutput } from '../roles/planner';
import type { ModelProvider } from './provider';

export async function runHeadChef(
  provider: ModelProvider,
  input: Omit<PlannerInput, 'ollama'>,
): Promise<PlannerOutput> {
  return runPlanner({ ...input, ollama: provider });
}
