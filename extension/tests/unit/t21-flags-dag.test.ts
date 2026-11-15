import { describe, expect, it, vi } from 'vitest';
import type { DagStep, Settings, TimelineEvent } from '@/shared/messages';
import { DEFAULT_SETTINGS } from '@/shared/messages';
import { dispatchDagPlan, resolveDagEnabled, wavesFor } from '@/agent/orchestrator';

// T21 flags + DAG wiring with canary/kill (BRAIN-only, 0 LLM calls).
// Default-off dagDispatch/dagCanary/dagKill (kill wins). Off/kill path is
// legacy sequential verbatim; on path (enabled OR canary, no kill) dispatches
// dependency waves via dispatchDagWave (input order + fallback) with a shadow
// log; cyclic graphs fail closed to sequential. Reuses wavesFor + dispatchDagWave.
describe('t21 flags default-off (T21)', () => {
  it('defaults dagDispatch/dagCanary/dagKill to false — safe by default', () => {
    expect(DEFAULT_SETTINGS.dagDispatch).toBe(false);
    expect((DEFAULT_SETTINGS as Settings).dagCanary).toBe(false);
    expect((DEFAULT_SETTINGS as Settings).dagKill).toBe(false);
  });

  it('a Partial<Settings> missing the flags merges to the baseline', () => {
    const partial: Partial<Settings> = { ...DEFAULT_SETTINGS };
    delete partial.dagDispatch;
    delete (partial as Partial<Settings>).dagCanary;
    delete (partial as Partial<Settings>).dagKill;
    expect(partial.dagDispatch).toBeUndefined();
    expect({ dagDispatch: false, dagCanary: false, dagKill: false, ...partial }).toEqual(
      DEFAULT_SETTINGS,
    );
  });
});

describe('resolveDagEnabled (T21)', () => {
  it('is off by default; enabled or canary turns it on', () => {
    expect(resolveDagEnabled()).toBe(false);
    expect(resolveDagEnabled({})).toBe(false);
    expect(resolveDagEnabled({ enabled: false, canary: false, kill: false })).toBe(false);
    expect(resolveDagEnabled({ enabled: true })).toBe(true);
    expect(resolveDagEnabled({ canary: true })).toBe(true);
    expect(resolveDagEnabled({ enabled: true, canary: true })).toBe(true);
  });

  it('kill wins over enabled and canary', () => {
    expect(resolveDagEnabled({ enabled: true, kill: true })).toBe(false);
    expect(resolveDagEnabled({ canary: true, kill: true })).toBe(false);
    expect(resolveDagEnabled({ enabled: true, canary: true, kill: true })).toBe(false);
    expect(resolveDagEnabled({ kill: true })).toBe(false);
  });
});

describe('wavesFor reuse (T21)', () => {
  it('groups independent steps into one wave in input order', () => {
    const steps: DagStep[] = [
      { id: 'a', description: 'first' },
      { id: 'b', description: 'second' },
      { id: 'c', description: 'third' },
    ];
    expect(wavesFor(steps).map((w) => w.map((s) => s.id))).toEqual([['a', 'b', 'c']]);
  });

  it('orders waves by dependencies, input order preserved within a wave', () => {
    const steps: DagStep[] = [
      { id: 'a', description: 'read page', provides: 'title' },
      { id: 'b', description: 'other read' },
      { id: 'c', description: 'summarize ${title}', needs: ['a'] },
    ];
    expect(wavesFor(steps).map((w) => w.map((s) => s.id))).toEqual([['a', 'b'], ['c']]);
  });

  it('fail-closed ([]): cyclic, self-need, dangling need, duplicate ids', () => {
    expect(
      wavesFor([
        { id: 'a', description: 'a needs b', needs: ['b'] },
        { id: 'b', description: 'b needs a', needs: ['a'] },
      ]),
    ).toEqual([]);
    expect(wavesFor([{ id: 'a', description: 'self', needs: ['a'] }])).toEqual([]);
    expect(
      wavesFor([
        { id: 'a', description: 'dangling', needs: ['ghost'] },
        { id: 'b', description: 'plain' },
      ]),
    ).toEqual([]);
    expect(
      wavesFor([
        { id: 'a', description: 'one' },
        { id: 'a', description: 'dup' },
      ]),
    ).toEqual([]);
  });
});

describe('dispatchDagPlan (T21)', () => {
  const steps: DagStep[] = [
    { id: 'a', description: 'first' },
    { id: 'b', description: 'second' },
    { id: 'c', description: 'third' },
  ];

  it('off path is legacy sequential verbatim: in-order, one run per step, no emits', async () => {
    const order: string[] = [];
    const emit = vi.fn();
    const run = vi.fn(async (s: DagStep) => {
      order.push(s.id);
      return `out-${s.id}`;
    });
    const results = await dispatchDagPlan(steps, run, {
      enabled: DEFAULT_SETTINGS.dagDispatch,
      emit,
    });
    expect(results).toEqual(['out-a', 'out-b', 'out-c']);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(run).toHaveBeenCalledTimes(3);
    expect(emit).not.toHaveBeenCalled();
  });

  it('on path dispatches waves in input order with a shadow log', async () => {
    const dag: DagStep[] = [
      { id: 'a', description: 'read', provides: 'title' },
      { id: 'b', description: 'other' },
      { id: 'c', description: 'join ${title}', needs: ['a'] },
    ];
    const events: TimelineEvent[] = [];
    const run = vi.fn(async (s: DagStep) => {
      const delay = s.id === 'a' ? 20 : 0;
      await new Promise((r) => setTimeout(r, delay));
      return `out-${s.id}`;
    });
    const results = await dispatchDagPlan(dag, run, {
      enabled: true,
      emit: (e) => events.push(e),
    });
    expect(results).toEqual(['out-a', 'out-b', 'out-c']);
    expect(run).toHaveBeenCalledTimes(3);
    expect(events.filter((e) => e.kind === 'log').length).toBeGreaterThanOrEqual(1);
  });

  it('on path keeps the parallel-failure sequential fallback', async () => {
    const pair: DagStep[] = [
      { id: 'a', description: 'first' },
      { id: 'b', description: 'second' },
    ];
    const order: string[] = [];
    let calls = 0;
    const run = async (s: DagStep) => {
      calls += 1;
      if (calls <= pair.length && s.id === 'b') throw new Error('boom');
      order.push(s.id);
      return `out-${s.id}`;
    };
    const results = await dispatchDagPlan(pair, run, { enabled: true });
    expect(results).toEqual(['out-a', 'out-b']);
    expect(order).toEqual(['a', 'a', 'b']);
  });

  it('on path with a cyclic graph fails closed to sequential (no hang, no throw)', async () => {
    const cyclic: DagStep[] = [
      { id: 'a', description: 'a needs b', needs: ['b'] },
      { id: 'b', description: 'b needs a', needs: ['a'] },
    ];
    const order: string[] = [];
    const events: TimelineEvent[] = [];
    const run = async (s: DagStep) => {
      order.push(s.id);
      return `out-${s.id}`;
    };
    const results = await dispatchDagPlan(cyclic, run, {
      enabled: true,
      emit: (e) => events.push(e),
    });
    expect(results).toEqual(['out-a', 'out-b']);
    expect(order).toEqual(['a', 'b']);
    expect(events.some((e) => e.kind === 'log')).toBe(true);
  });

  it('canary enables wave dispatch without dagDispatch', async () => {
    const dag: DagStep[] = [
      { id: 'a', description: 'read', provides: 'title' },
      { id: 'b', description: 'other' },
      { id: 'c', description: 'join ${title}', needs: ['a'] },
    ];
    const events: TimelineEvent[] = [];
    const run = vi.fn(async (s: DagStep) => `out-${s.id}`);
    const results = await dispatchDagPlan(dag, run, {
      enabled: false,
      canary: true,
      emit: (e) => events.push(e),
    });
    expect(results).toEqual(['out-a', 'out-b', 'out-c']);
    expect(run).toHaveBeenCalledTimes(3);
    expect(events.filter((e) => e.kind === 'log').length).toBeGreaterThanOrEqual(1);
  });

  it('kill wins: forces sequential verbatim with no emits even when enabled + canary', async () => {
    const order: string[] = [];
    const emit = vi.fn();
    const run = vi.fn(async (s: DagStep) => {
      order.push(s.id);
      return `out-${s.id}`;
    });
    const results = await dispatchDagPlan(steps, run, {
      enabled: true,
      canary: true,
      kill: true,
      emit,
    });
    expect(results).toEqual(['out-a', 'out-b', 'out-c']);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(run).toHaveBeenCalledTimes(3);
    expect(emit).not.toHaveBeenCalled();
  });
});
