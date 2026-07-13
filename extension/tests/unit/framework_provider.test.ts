import { describe, it, expect } from 'vitest';
import { localProvider, frontierProvider, openAICompatibleProvider, withFallback, withThinkingOverride, resolveProvider, type ModelProvider } from '@/agent/framework/provider';
import type { OllamaClient } from '@/background/ollama';
import { DEFAULT_SETTINGS } from '@/shared/messages';
import { makeFakeOllama } from '../helpers';

describe('localProvider', () => {
  it('delegates chatOnce to the wrapped OllamaClient', async () => {
    const fake = makeFakeOllama({ executor: [] });
    const provider = localProvider(fake);
    const res = await provider.chatOnce({ model: 'x', messages: [{ role: 'system', content: 'You are the EXECUTOR' }] });
    expect(res.rawText).toBe('{}'); // makeFakeOllama's default when a queue is empty
  });
});

describe('frontierProvider', () => {
  it('translates a system+user request and returns the text response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: '{"steps":[]}' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = frontierProvider({ provider: 'anthropic', apiKey: 'sk-test', model: 'claude-opus-4-8' });
    const res = await provider.chatOnce({
      model: 'claude-opus-4-8',
      messages: [
        { role: 'system', content: 'You are the PLANNER' },
        { role: 'user', content: 'plan this' },
      ],
      format: 'json',
    });

    expect(res.rawText).toBe('{"steps":[]}');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('sk-test');
    const body = JSON.parse(init.body);
    expect(body.system).toBe('You are the PLANNER');
    expect(body.messages).toEqual([{ role: 'user', content: 'plan this' }]);
    expect(body.max_tokens).toBe(4096);
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    expect(init.headers['content-type']).toBe('application/json');

    vi.unstubAllGlobals();
  });

  it('throws on a policy refusal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [], stop_reason: 'refusal', stop_details: { category: 'cyber' } }),
    }));
    const provider = frontierProvider({ provider: 'anthropic', apiKey: 'sk-test', model: 'claude-opus-4-8' });
    await expect(provider.chatOnce({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/declined/);
    vi.unstubAllGlobals();
  });

  it('throws a status-bearing error on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' }));
    const provider = frontierProvider({ provider: 'anthropic', apiKey: 'sk-test', model: 'claude-opus-4-8' });
    await expect(provider.chatOnce({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ status: 500 });
    vi.unstubAllGlobals();
  });

  it('sends thinking:disabled when opts.thinking is explicitly false', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'ok' }], usage: {} }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = frontierProvider({ provider: 'anthropic', apiKey: 'sk-test', model: 'claude-opus-4-8' });
    await provider.chatOnce({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'x' }], thinking: false });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.thinking).toEqual({ type: 'disabled' });
    vi.unstubAllGlobals();
  });

  it('sends thinking:adaptive when opts.thinking is true or omitted', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'ok' }], usage: {} }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = frontierProvider({ provider: 'anthropic', apiKey: 'sk-test', model: 'claude-opus-4-8' });
    await provider.chatOnce({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'x' }], thinking: true });
    await provider.chatOnce({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'x' }] }); // omitted
    const body1 = JSON.parse(fetchMock.mock.calls[0][1].body);
    const body2 = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body1.thinking).toEqual({ type: 'adaptive' });
    expect(body2.thinking).toEqual({ type: 'adaptive' });
    vi.unstubAllGlobals();
  });

  it('throws on a response with no text content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [], stop_reason: 'end_turn', usage: {} }),
    }));
    const provider = frontierProvider({ provider: 'anthropic', apiKey: 'sk-test', model: 'claude-opus-4-8' });
    await expect(provider.chatOnce({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/no text or tool call content/);
    vi.unstubAllGlobals();
  });
});

describe('openAICompatibleProvider', () => {
  it('translates a request and returns the text response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'the answer' } }],
        usage: { prompt_tokens: 12, completion_tokens: 8 },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = openAICompatibleProvider({
      provider: 'openai-compatible',
      apiKey: 'sk-oa-test',
      model: 'gpt-5.1',
      baseUrl: 'https://api.openai.com/v1/chat/completions',
    });
    const res = await provider.chatOnce({
      model: 'gpt-5.1',
      messages: [
        { role: 'system', content: 'You are the PLANNER' },
        { role: 'user', content: 'plan this' },
      ],
    });

    expect(res.rawText).toBe('the answer');
    expect(res.promptEvalCount).toBe(12);
    expect(res.evalCount).toBe(8);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers.authorization).toBe('Bearer sk-oa-test');
    expect(init.headers['content-type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('gpt-5.1');
    expect(body.max_tokens).toBe(4096);
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are the PLANNER' },
      { role: 'user', content: 'plan this' },
    ]);
    expect(body.reasoning_effort).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it('sends reasoning_effort only when opts.thinking is true', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = openAICompatibleProvider({
      provider: 'openai-compatible', apiKey: 'sk-x', model: 'gpt-5.1', baseUrl: 'https://x/chat/completions',
    });
    await provider.chatOnce({ model: 'gpt-5.1', messages: [{ role: 'user', content: 'x' }], thinking: true });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.reasoning_effort).toBe('medium');
    vi.unstubAllGlobals();
  });

  it('throws on a refusal field in the response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { refusal: 'policy' } }] }),
    }));
    const provider = openAICompatibleProvider({
      provider: 'openai-compatible', apiKey: 'sk-x', model: 'gpt-5.1', baseUrl: 'https://x/chat/completions',
    });
    await expect(
      provider.chatOnce({ model: 'gpt-5.1', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow(/declined/);
    vi.unstubAllGlobals();
  });

  it('throws a status-bearing error on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => 'rate limited' }));
    const provider = openAICompatibleProvider({
      provider: 'openai-compatible', apiKey: 'sk-x', model: 'gpt-5.1', baseUrl: 'https://x/chat/completions',
    });
    await expect(
      provider.chatOnce({ model: 'gpt-5.1', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ status: 429 });
    vi.unstubAllGlobals();
  });

  it('throws on a response with no text content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '' } }] }),
    }));
    const provider = openAICompatibleProvider({
      provider: 'openai-compatible', apiKey: 'sk-x', model: 'gpt-5.1', baseUrl: 'https://x/chat/completions',
    });
    await expect(
      provider.chatOnce({ model: 'gpt-5.1', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow(/no text or tool call content/);
    vi.unstubAllGlobals();
  });
});

describe('withFallback', () => {
  it('passes through a successful primary call untouched', async () => {
    const primary = { chatOnce: vi.fn().mockResolvedValue({ message: { role: 'assistant', content: 'ok' }, done: true, toolCalls: [], rawText: 'ok' }) };
    const fallback = { chatOnce: vi.fn() };
    const provider = withFallback(primary, fallback);
    const res = await provider.chatOnce({ model: 'x', messages: [] });
    expect(res.rawText).toBe('ok');
    expect(fallback.chatOnce).not.toHaveBeenCalled();
  });

  it('retries once on a 5xx, then falls back on continued failure', async () => {
    const err500 = Object.assign(new Error('server error'), { status: 500 });
    const primary = { chatOnce: vi.fn().mockRejectedValue(err500) };
    const fallback = { chatOnce: vi.fn().mockResolvedValue({ message: { role: 'assistant', content: 'local' }, done: true, toolCalls: [], rawText: 'local' }) };
    const onFallback = vi.fn();
    const provider = withFallback(primary, fallback, onFallback);
    const res = await provider.chatOnce({ model: 'x', messages: [] });
    expect(primary.chatOnce).toHaveBeenCalledTimes(2); // one retry
    expect(res.rawText).toBe('local');
    expect(onFallback).toHaveBeenCalledWith('server error');
  });

  it('falls back immediately on a non-retryable error, no retry', async () => {
    const err401 = Object.assign(new Error('bad key'), { status: 401 });
    const primary = { chatOnce: vi.fn().mockRejectedValue(err401) };
    const fallback = { chatOnce: vi.fn().mockResolvedValue({ message: { role: 'assistant', content: 'local' }, done: true, toolCalls: [], rawText: 'local' }) };
    const provider = withFallback(primary, fallback);
    await provider.chatOnce({ model: 'x', messages: [] });
    expect(primary.chatOnce).toHaveBeenCalledTimes(1); // no retry
  });
});

describe('withThinkingOverride', () => {
  it('passes through the exact same provider reference when override is undefined', async () => {
    const inner = { chatOnce: vi.fn().mockResolvedValue({ message: { role: 'assistant', content: 'ok' }, done: true, toolCalls: [], rawText: 'ok' }) };
    const provider = withThinkingOverride(inner, undefined);
    expect(provider).toBe(inner); // true no-op, not a functionally-equivalent wrapper
    await provider.chatOnce({ model: 'x', messages: [], thinking: false });
    expect(inner.chatOnce).toHaveBeenCalledWith({ model: 'x', messages: [], thinking: false });
  });

  it('forces opts.thinking to the override value', async () => {
    const inner = { chatOnce: vi.fn().mockResolvedValue({ message: { role: 'assistant', content: 'ok' }, done: true, toolCalls: [], rawText: 'ok' }) };
    const provider = withThinkingOverride(inner, true);
    await provider.chatOnce({ model: 'x', messages: [], thinking: false });
    expect(inner.chatOnce).toHaveBeenCalledWith({ model: 'x', messages: [], thinking: true });
  });
});

describe('resolveProvider', () => {
  const fakeLocal = makeFakeOllama({});

  it('resolves ollama provider to local identity', () => {
    const p = resolveProvider({ provider: 'ollama', model: 'gemma4:e4b' }, fakeLocal);
    expect(p).toBe(fakeLocal); // localProvider is identity
  });

  it('resolves to frontier with fallback for anthropic', () => {
    const p = resolveProvider({ provider: 'anthropic', model: 'claude-opus-4-8', apiKey: 'sk-test' }, fakeLocal);
    expect(p).not.toBe(fakeLocal); // wrapped in withFallback
  });

  it('routes to openai-compatible when provider is openai-compatible', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'hi' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const p = resolveProvider(
      { provider: 'openai-compatible', model: 'gpt-5.1', apiKey: 'sk-x', baseUrl: 'https://api.openai.com/v1/chat/completions' },
      fakeLocal,
    );
    await p.chatOnce({ model: 'x', messages: [{ role: 'user', content: 'hi' }] });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
    vi.unstubAllGlobals();
  });

  it('applies thinkingLevel "full" as thinking:true with effort "high"', async () => {
    const captured: Array<{ thinking?: boolean; thinkingEffort?: string }> = [];
    const fake = {
      chatOnce: async (opts: { thinking?: boolean; thinkingEffort?: string }) => {
        captured.push(opts);
        return { message: { role: 'assistant', content: 'ok' }, done: true, toolCalls: [], rawText: 'ok' };
      },
    } as unknown as OllamaClient;
    const p = resolveProvider({ provider: 'ollama', model: 'x', thinkingLevel: 'full' }, fake);
    await p.chatOnce({ model: 'x', messages: [], thinking: false });
    expect(captured[0].thinking).toBe(true);
    expect(captured[0].thinkingEffort).toBe('high');
  });

  it('thinkingLevel "fast" maps to thinking:true effort:low', async () => {
    const captured: Array<{ thinking?: boolean; thinkingEffort?: string }> = [];
    const fake = {
      chatOnce: async (opts: { thinking?: boolean; thinkingEffort?: string }) => {
        captured.push(opts);
        return { message: { role: 'assistant', content: 'ok' }, done: true, toolCalls: [], rawText: 'ok' };
      },
    } as unknown as OllamaClient;
    const p = resolveProvider({ provider: 'ollama', model: 'x', thinkingLevel: 'fast' }, fake);
    await p.chatOnce({ model: 'x', messages: [], thinking: false });
    expect(captured[0].thinking).toBe(true);
    expect(captured[0].thinkingEffort).toBe('low');
  });

  it('thinkingLevel "off" applies no override', async () => {
    const captured: Array<{ thinking?: boolean }> = [];
    const fake = {
      chatOnce: async (opts: { thinking?: boolean }) => {
        captured.push(opts);
        return { message: { role: 'assistant', content: 'ok' }, done: true, toolCalls: [], rawText: 'ok' };
      },
    } as unknown as OllamaClient;
    const p = resolveProvider({ provider: 'ollama', model: 'x', thinkingLevel: 'off' }, fake);
    await p.chatOnce({ model: 'x', messages: [], thinking: false });
    expect(captured[0].thinking).toBe(false); // no override, original call's thinking:false passes through
  });

  it('thinkingLevel "standard" maps to thinking:true effort:medium', async () => {
    const captured: Array<{ thinkingEffort?: string }> = [];
    const fake = {
      chatOnce: async (opts: { thinkingEffort?: string }) => {
        captured.push(opts);
        return { message: { role: 'assistant', content: 'ok' }, done: true, toolCalls: [], rawText: 'ok' };
      },
    } as unknown as OllamaClient;
    const p = resolveProvider({ provider: 'ollama', model: 'x', thinkingLevel: 'standard' }, fake);
    await p.chatOnce({ model: 'x', messages: [], thinking: true });
    expect(captured[0].thinkingEffort).toBe('medium');
  });
});
