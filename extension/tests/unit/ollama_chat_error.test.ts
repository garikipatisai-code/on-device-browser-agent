import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OllamaClient } from '@/background/ollama';

describe('OllamaClient.chatOnce — actionable 403 (origin blocked)', () => {
  let origFetch: typeof globalThis.fetch;
  beforeEach(() => {
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('turns a 403 into the OLLAMA_ORIGINS fix, not a bare status code', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 403, text: async () => '' }) as Response) as typeof globalThis.fetch;
    await expect(
      new OllamaClient('http://localhost:11434').chatOnce({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/OLLAMA_ORIGINS/);
  });
});
