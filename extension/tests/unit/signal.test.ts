import { describe, expect, it } from 'vitest';
import { composeSignal, sleep } from '@/background/signal';

describe('composeSignal', () => {
  it('aborts on timeout', async () => {
    const { signal, cleanup } = composeSignal(10);
    await new Promise((r) => setTimeout(r, 30));
    expect(signal.aborted).toBe(true);
    expect((signal.reason as DOMException).name).toBe('TimeoutError');
    cleanup();
  });

  it('cleanup cancels pending timeout', async () => {
    const { signal, cleanup } = composeSignal(100);
    cleanup();
    await new Promise((r) => setTimeout(r, 150));
    expect(signal.aborted).toBe(false);
  });

  it('propagates user abort', async () => {
    const user = new AbortController();
    const { signal, cleanup } = composeSignal(10_000, user.signal);
    user.abort(new DOMException('user', 'AbortError'));
    expect(signal.aborted).toBe(true);
    cleanup();
  });

  it('aborts immediately if user signal is already aborted', () => {
    const user = new AbortController();
    user.abort();
    const { signal, cleanup } = composeSignal(10_000, user.signal);
    expect(signal.aborted).toBe(true);
    cleanup();
  });

  it('cleanup is idempotent', () => {
    const { cleanup } = composeSignal(50);
    cleanup();
    expect(() => cleanup()).not.toThrow();
  });
});

describe('sleep', () => {
  it('resolves after the given ms', async () => {
    const t0 = Date.now();
    await sleep(20);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
  });

  it('rejects if signal already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(sleep(100, ac.signal)).rejects.toBeDefined();
  });

  it('cancels when signal aborts mid-sleep', async () => {
    const ac = new AbortController();
    const p = sleep(500, ac.signal);
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toBeDefined();
  });
});
