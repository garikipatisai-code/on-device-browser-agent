// The helper seat: does the tool-calling grunt work. Wraps roles/executor.ts
// and roles/compactor.ts unchanged — always local-provider-backed in this
// phase (see docs/superpowers/specs/2026-07-02-agent-framework-model-tiering-design.md,
// "Explicitly NOT doing" — concurrent helpers are a follow-on spec).
import { runExecutor, type ExecutorInput, type ExecutorOutput } from '../roles/executor';
import { runCompactor, type CompactorInput, type CompactorOutput } from '../roles/compactor';
import type { ModelProvider } from './provider';

export async function runHelper(
  provider: ModelProvider,
  input: Omit<ExecutorInput, 'ollama'>,
): Promise<ExecutorOutput> {
  return runExecutor({ ...input, ollama: provider });
}

export async function runHelperCompaction(
  provider: ModelProvider,
  input: Omit<CompactorInput, 'ollama'>,
): Promise<CompactorOutput> {
  return runCompactor({ ...input, ollama: provider });
}
