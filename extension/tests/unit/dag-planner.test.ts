import { describe, expect, it, vi } from 'vitest';
import type { DagStep } from '@/shared/messages';
import { dispatchDagWave, joinVarRefs, parseDagPlan } from '@/agent/orchestrator';

// T6 DAG planner (BRAIN-only): deterministic parse + ${var} join + parallel
// dispatch with sequential fallback. The runner is injected so this test makes
// 0 LLM calls; production passes a runHelper-backed runner.
describe('dag planner (T6)', () => {
  it('parseDagPlan parses steps with needs/provides, fail-closed on invalid', () => {
    const steps = parseDagPlan({
      steps: [
        { id: 'a', description: 'read page', provides: 'title' },
        { id: 'b', description: 'summarize ${title}', needs: ['a'] },
      ],
    });
    expect(steps.map((s) => s.id)).toEqual(['a', 'b']);
    expect(steps[1].needs).toEqual(['a']);
    expect(steps[0].provides).toBe('title');

    expect(parseDagPlan(null)).toEqual([]);
    expect(parseDagPlan({})).toEqual([]);
    expect(parseDagPlan({ steps: 'nope' })).toEqual([]);
    expect(parseDagPlan({ steps: [{ description: 'missing id' }] })).toEqual([]);
  });

  it('joinVarRefs substitutes ${var} refs, missing var is empty', () => {
    expect(joinVarRefs('price of ${title} is ${price}', { title: 'Book', price: '$9' })).toBe(
      'price of Book is $9',
    );
    expect(joinVarRefs('hello ${missing}!', {})).toBe('hello !');
    expect(joinVarRefs('no refs', { a: 'b' })).toBe('no refs');
  });

  it('parallel dispatch is deterministic (input order regardless of finish order)', async () => {
    const steps: DagStep[] = [
      { id: 'a', description: 'first' },
      { id: 'b', description: 'second' },
      { id: 'c', description: 'third' },
    ];
    // Later steps resolve first — results must still follow input order.
    const run = vi.fn(async (s: DagStep) => {
      const delay = s.id === 'a' ? 30 : s.id === 'b' ? 10 : 0;
      await new Promise((r) => setTimeout(r, delay));
      return `out-${s.id}`;
    });
    const results = await dispatchDagWave(steps, run);
    expect(results).toEqual(['out-a', 'out-b', 'out-c']);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('falls back to sequential when parallel dispatch fails', async () => {
    const steps: DagStep[] = [
      { id: 'a', description: 'first' },
      { id: 'b', description: 'second' },
    ];
    const order: string[] = [];
    let calls = 0;
    const run = async (s: DagStep) => {
      calls += 1;
      // Fail only during the parallel phase (first wave of calls); the
      // sequential fallback re-runs every step in order and must succeed.
      if (calls <= steps.length && s.id === 'b') throw new Error('boom');
      order.push(s.id);
      return `out-${s.id}`;
    };
    const results = await dispatchDagWave(steps, run);
    expect(results).toEqual(['out-a', 'out-b']);
    expect(order).toEqual(['a', 'a', 'b']);
  });
});
