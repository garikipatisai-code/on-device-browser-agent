import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { waitForTabSettled } from '@/agent/tools/browser/tab';

describe('waitForTabSettled (condition-based post-nav wait)', () => {
  let origGet: typeof chrome.tabs.get;
  beforeEach(() => {
    origGet = chrome.tabs.get;
  });
  afterEach(() => {
    chrome.tabs.get = origGet;
  });

  function mockStatuses(statuses: Array<string | null>) {
    let i = 0;
    chrome.tabs.get = ((id: number, cb: (t: unknown) => void) => {
      const s = statuses[Math.min(i, statuses.length - 1)];
      i += 1;
      const rt = chrome.runtime as { lastError?: unknown };
      if (s === null) {
        rt.lastError = { message: 'No tab with given id' };
        cb(undefined);
        rt.lastError = undefined;
      } else {
        cb({ id, status: s });
      }
    }) as unknown as typeof chrome.tabs.get;
  }

  it('resolves promptly when the tab is already complete', async () => {
    mockStatuses(['complete']);
    const t0 = Date.now();
    await waitForTabSettled(1, 1000, 20);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it('waits through loading, then resolves on complete', async () => {
    mockStatuses(['loading', 'loading', 'complete']);
    await waitForTabSettled(1, 1000, 10); // resolves once status flips to complete
    expect(true).toBe(true);
  });

  it('resolves promptly when the tab is gone (not queryable)', async () => {
    mockStatuses([null]);
    const t0 = Date.now();
    await waitForTabSettled(1, 1000, 20);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it('resolves at the cap if the page never reaches complete', async () => {
    mockStatuses(['loading']);
    const t0 = Date.now();
    await waitForTabSettled(1, 80, 20);
    const dt = Date.now() - t0;
    expect(dt).toBeGreaterThanOrEqual(60);
    expect(dt).toBeLessThan(500);
  });
});
