// The seam every seat (head chef, sous chef, helper) calls through — lets a
// seat's model backend be swapped without the seat's own code knowing.
import type { ChatOptions, ChatResponse, OllamaClient } from '@/background/ollama';

export interface ModelProvider {
  chatOnce(opts: ChatOptions): Promise<ChatResponse>;
}

// OllamaClient already structurally satisfies ModelProvider (it has chatOnce
// with this exact shape) — this is an identity function, kept as a named,
// self-documenting call site rather than passing the client bare.
export function localProvider(ollama: OllamaClient): ModelProvider {
  return ollama;
}
