import { describe, it, expect } from 'vitest';
import { localProvider, frontierProvider, withFallback, resolveLeadProvider } from '@/agent/framework/provider';
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

describe('resolveLeadProvider', () => {
  it('resolves to local when hybridMode is off', () => {
    const fake = makeFakeOllama({});
    const p = resolveLeadProvider({ ...DEFAULT_SETTINGS, hybridMode: false }, fake);
    expect(p).toBe(fake); // localProvider is an identity function
  });

  it('resolves to local when hybridMode is on but no frontier config is present', () => {
    const fake = makeFakeOllama({});
    const p = resolveLeadProvider({ ...DEFAULT_SETTINGS, hybridMode: true }, fake);
    expect(p).toBe(fake);
  });

  it('resolves to a fallback-wrapped frontier provider when fully configured', () => {
    const fake = makeFakeOllama({});
    const p = resolveLeadProvider(
      { ...DEFAULT_SETTINGS, hybridMode: true, frontier: { provider: 'anthropic', apiKey: 'sk-test', model: 'claude-opus-4-8' } },
      fake,
    );
    expect(p).not.toBe(fake);
  });
});
