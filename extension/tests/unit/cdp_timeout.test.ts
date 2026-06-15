import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withCdp } from '@/agent/tools/browser/lifecycle';

// Regression: a CDP command whose callback never fires (renderer hung on a
// still-loading/background tab) must NOT freeze the agent — it froze for 9 min
// in a real run until the watchdog. withCdp now bounds every command.
describe('withCdp command timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as unknown as { chrome: unknown }).chrome = {
      debugger: {
        attach: (_t: unknown, _v: unknown, cb: () => void) => cb(),
        detach: (_t: unknown, cb: () => void) => cb(),
        // never invokes the callback → simulates a hung CDP command
        sendCommand: (_t: unknown, _m: unknown, _p: unknown, _cb: (r?: unknown) => void) => undefined,
      },
      runtime: { lastError: undefined },
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it('rejects a hung command instead of hanging forever', async () => {
    const p = withCdp(1, (send) => send('Input.dispatchMouseEvent', { type: 'mouseWheel' }));
    const assertion = expect(p).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(21_000);
    await assertion;
  });
});
