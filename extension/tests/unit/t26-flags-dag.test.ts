import { describe, expect, it, vi } from 'vitest';
import type { DagStep, Settings, TimelineEvent } from '@/shared/messages';
import { DEFAULT_SETTINGS } from '@/shared/messages';
import { dagDispatchOpts, dispatchDagPlan, resolveDagEnabled } from '@/agent/orchestrator';

// T26 flags + DAG wiring into executeOne (BRAIN-only, 0 LLM calls).
// `dagDispatchOpts(settings, emit?)` maps Settings.dagDispatch/dagCanary/dagKill
// to dispatchDagPlan opts; executeOne routes its single runHelper call through
// dispatchDagPlan with those opts. Off/kill = legacy sequential verbatim (no
// emits); on (enabled OR canary, no kill) = wave dispatch + shadow log with
// sequential fallback; cyclic fails closed to sequential. Reuses
// resolveDagEnabled + wavesFor + dispatchDagWave unchanged.
describe('t26 flags default-off (T26)', () => {
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

describe('dagDispatchOpts settings mapping (T26)', () => {
  it('maps dagDispatch/dagCanary/dagKill to enabled/canary/kill', () => {
    expect(dagDispatchOpts({ ...DEFAULT_SETTINGS, dagDispatch: true }).enabled).toBe(true);
    expect(dagDispatchOpts({ ...DEFAULT_SETTINGS, dagCanary: true }).canary).toBe(true);
    expect(dagDispatchOpts({ ...DEFAULT_SETTINGS, dagKill: true }).kill).toBe(true);
  });

  it('missing flags merge to off (fail-closed)', () => {
    const partial: Partial<Settings> = { ...DEFAULT_SETTINGS };
    delete partial.dagDispatch;
    delete (partial as Partial<Settings>).dagCanary;
    delete (partial as Partial<Settings>).dagKill;
    const opts = dagDispatchOpts(partial as Settings);
    expect(resolveDagEnabled(opts)).toBe(false);
  });

  it('kill wins over enabled and canary at the seam', () => {
    const opts = dagDispatchOpts({ ...DEFAULT_SETTINGS, dagDispatch: true, dagCanary: true, dagKill: true });
    expect(resolveDagEnabled(opts)).toBe(false);
  });
});

describe('executeOne dispatch seam (T26)', () => {
  const step: DagStep[] = [{ id: 'step-1', description: 'only step' }];

  it('off path is byte-identical: in-order single run, no emits', async () => {
    const order: string[] = [];
    const emit = vi.fn();
    const run = vi.fn(async (s: DagStep) => {
      order.push(s.id);
      return `out-${s.id}`;
    });
    const results = await dispatchDagPlan(step, run, dagDispatchOpts(DEFAULT_SETTINGS, emit));
    expect(results).toEqual(['out-step-1']);
    expect(order).toEqual(['step-1']);
    expect(run).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
  });

  it('on path dispatches the wave in input order with a shadow log', async () => {
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
    const results = await dispatchDagPlan(
      dag,
      run,
      dagDispatchOpts({ ...DEFAULT_SETTINGS, dagDispatch: true }, (e) => events.push(e)),
    );
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
    const results = await dispatchDagPlan(
      pair,
      run,
      dagDispatchOpts({ ...DEFAULT_SETTINGS, dagDispatch: true }),
    );
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
    const results = await dispatchDagPlan(
      cyclic,
      run,
      dagDispatchOpts({ ...DEFAULT_SETTINGS, dagDispatch: true }, (e) => events.push(e)),
    );
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
    const results = await dispatchDagPlan(
      dag,
      run,
      dagDispatchOpts({ ...DEFAULT_SETTINGS, dagCanary: true }, (e) => events.push(e)),
    );
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
    const results = await dispatchDagPlan(
      step,
      run,
      dagDispatchOpts({ ...DEFAULT_SETTINGS, dagDispatch: true, dagCanary: true, dagKill: true }, emit),
    );
    expect(results).toEqual(['out-step-1']);
    expect(order).toEqual(['step-1']);
    expect(run).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
  });
});
