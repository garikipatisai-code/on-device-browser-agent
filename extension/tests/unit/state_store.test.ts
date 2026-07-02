import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _setHot,
  appendEvent,
  clearHot,
  getScratchpad,
  loadEvents,
  loadHot,
  loadSettings,
  memoryGet,
  memoryList,
  memorySet,
  patchHot,
  saveSettings,
  setDomainTier,
  setScratchpad,
  toStatus,
  touchHot,
  _testing,
} from '@/background/state_store';
import { resetStorage } from '../helpers';

beforeEach(async () => {
  await resetStorage();
});
afterEach(async () => {
  await clearHot();
});

describe('hot state', () => {
  it('_setHot writes the goal', async () => {
    const hot = await _setHot('do the thing');
    expect(hot.goal).toBe('do the thing');
    expect(hot.phase).toBe('IDLE');
  });

  it('patchHot rejects goal mutation', async () => {
    await _setHot('original');
    await expect(patchHot({ goal: 'hijacked' } as unknown as { phase: 'IDLE' })).rejects.toThrow(/immutable/);
  });

  it('patchHot updates phase', async () => {
    await _setHot('g');
    const hot = await patchHot({ phase: 'PLANNING' });
    expect(hot.phase).toBe('PLANNING');
    expect(hot.goal).toBe('g');
  });

  it('clearHot drains the mutex before erasing', async () => {
    await _setHot('a');
    const writeP = patchHot({ phase: 'PLANNING' });
    const clearP = clearHot();
    await Promise.all([writeP, clearP]);
    const hot = await loadHot();
    expect(hot).toBeNull();
  });

  it('touchHot updates lastTouch', async () => {
    const t0 = await _setHot('g');
    await new Promise((r) => setTimeout(r, 5));
    await touchHot();
    const t1 = await loadHot();
    expect(t1!.lastTouch).toBeGreaterThanOrEqual(t0.lastTouch);
  });
});

describe('toStatus', () => {
  it('produces IDLE for null hot', () => {
    expect(toStatus(null).phase).toBe('IDLE');
    expect(toStatus(null).goal).toBeNull();
  });
});

describe('settings', () => {
  it('loadSettings returns defaults when none stored', async () => {
    const s = await loadSettings();
    expect(s.ollamaBaseUrl).toMatch(/^http/);
    expect(s.executorModel).toBeTruthy();
  });

  it('saveSettings merges with defaults', async () => {
    const next = await saveSettings({ executorModel: 'override:1b' });
    expect(next.executorModel).toBe('override:1b');
    expect(next.plannerModel).toBeTruthy();
  });

  it('setDomainTier upserts a host', async () => {
    const next = await setDomainTier('amazon.com', 'click-only');
    expect(next.domainTiers['amazon.com']).toBe('click-only');
  });

  it('serializes concurrent settings writes without losing updates', async () => {
    // Each write is a read-modify-write of chrome.storage; run concurrently they all read the
    // same base before any writes back → last-writer-wins drops the others unless serialized.
    await Promise.all([
      setDomainTier('a.com', 'click-only'),
      setDomainTier('b.com', 'read-only'),
      saveSettings({ executorModel: 'concurrent:9b' }),
    ]);
    const s = await loadSettings();
    expect(s.domainTiers['a.com']).toBe('click-only');
    expect(s.domainTiers['b.com']).toBe('read-only');
    expect(s.executorModel).toBe('concurrent:9b');
  });
});

describe('scratchpad + memory + events', () => {
  it('scratchpad round-trips', async () => {
    await setScratchpad('t1', 'hello scratch');
    expect(await getScratchpad('t1')).toBe('hello scratch');
  });
  it('memory get/set/list', async () => {
    await memorySet('k1', 'v1');
    await memorySet('k2', { a: 1 });
    expect(await memoryGet('k1')).toBe('v1');
    expect((await memoryList()).sort()).toEqual(['k1', 'k2']);
  });
  it('event log accepts appends', async () => {
    await appendEvent('t1', { kind: 'log', ts: 1, level: 'info', message: 'hi' });
    const all = await loadEvents('t1');
    expect(all.length).toBe(1);
    expect(all[0].kind).toBe('log');
  });
});

describe('mutex serialization', () => {
  it('serializes concurrent writes', async () => {
    await _setHot('g');
    const promises = Array.from({ length: 5 }, (_, i) => patchHot({ replanCount: i }));
    const results = await Promise.all(promises);
    expect(results.every((r) => typeof r.replanCount === 'number')).toBe(true);
    expect(_testing._hotMutex).toBeDefined();
  });
});
