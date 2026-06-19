import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OllamaClient } from '@/background/ollama';

describe('OllamaClient.listModels — graceful on failure', () => {
  let origFetch: typeof globalThis.fetch;
  beforeEach(() => {
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('returns [] on a network error instead of throwing (preflight stays graceful)', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('network down');
    }) as typeof globalThis.fetch;
    expect(await new OllamaClient('http://localhost:11434').listModels()).toEqual([]);
  });

  it('returns [] on a non-ok response', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response) as typeof globalThis.fetch;
    expect(await new OllamaClient('http://localhost:11434').listModels()).toEqual([]);
  });
});
