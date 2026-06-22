// Compactor role.
import type { OllamaClient } from '@/background/ollama';
import { parseJSONPermissive } from '../util';
import { buildCompactorMessages } from '../prompts';
import { NUM_CTX } from '../budget';

export interface CompactorInput {
  goal: string;
  toolCatalog: string;
  scratchpad: string;
  model: string;
  ollama: OllamaClient;
  signal?: AbortSignal;
  timeoutMs?: number;
  numCtx?: number;
}

export interface CompactorOutput {
  summary: string;
  raw: string;
  charsBefore: number;
  charsAfter: number;
}

export async function runCompactor(input: CompactorInput): Promise<CompactorOutput> {
  const messages = buildCompactorMessages(input.goal, input.toolCatalog, input.scratchpad);
  const resp = await input.ollama.chatOnce({
    model: input.model,
    messages,
    format: 'json',
    thinking: false,
    timeoutMs: input.timeoutMs ?? 60_000,
    signal: input.signal,
    numCtx: input.numCtx ?? NUM_CTX,
  });
  const raw = resp.message.content ?? '';
  const parsed = parseJSONPermissive<{ summary?: string }>(raw);
  const summary = typeof parsed?.summary === 'string' && parsed.summary.trim() ? parsed.summary : raw.slice(0, 1_500);
  return {
    summary,
    raw,
    charsBefore: input.scratchpad.length,
    charsAfter: summary.length,
  };
}
