import { describe, it, expect } from 'vitest';
import { localProvider } from '@/agent/framework/provider';
import { makeFakeOllama } from '../helpers';

describe('localProvider', () => {
  it('delegates chatOnce to the wrapped OllamaClient', async () => {
    const fake = makeFakeOllama({ executor: [] });
    const provider = localProvider(fake);
    const res = await provider.chatOnce({ model: 'x', messages: [{ role: 'system', content: 'You are the EXECUTOR' }] });
    expect(res.rawText).toBe('{}'); // makeFakeOllama's default when a queue is empty
  });
});
