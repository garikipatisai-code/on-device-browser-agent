// T5: loop guards (BRAIN TDD) — evaluator stage-gate, bounded
// retry→reformat→switch→terminate, budget compact trigger, quick-chat fast path.
import { describe, expect, it } from 'vitest';
import { LoopGuard, isQuickChat } from '@/agent/orchestrator';
import { COMPACT_TRIGGER_FRAC, shouldCompact } from '@/agent/budget';

describe('evaluator stage-gate', () => {
  it('advances only on PASS', () => {
    const guard = new LoopGuard();
    expect(guard.stageGate('PASS')).toBe(true);
    expect(guard.stageGate('FAIL')).toBe(false);
  });
});

describe('bounded retry→reformat→switch→terminate (<1 extra)', () => {
  it('escalates in order then sticks at terminate', () => {
    const guard = new LoopGuard();
    expect(guard.recordFailure()).toBe('retry');
    expect(guard.recordFailure()).toBe('reformat');
    expect(guard.recordFailure()).toBe('switch');
    expect(guard.recordFailure()).toBe('terminate');
  });

  it('never emits an extra action past terminate', () => {
    const guard = new LoopGuard();
    const actions = [
      guard.recordFailure(),
      guard.recordFailure(),
      guard.recordFailure(),
      guard.recordFailure(),
      guard.recordFailure(),
      guard.recordFailure(),
      guard.recordFailure(),
      guard.recordFailure(),
      guard.recordFailure(),
      guard.recordFailure(),
      guard.recordFailure(),
      guard.recordFailure(),
      guard.recordFailure(),
      guard.recordFailure(),
    ];
    const extrasPastTerminate = actions.slice(4).filter((a) => a !== 'terminate');
    expect(extrasPastTerminate).toHaveLength(0);
  });
});

describe('budget compact TRIGGER', () => {
  it('triggers above the compact fraction of budget, not below', () => {
    const budget = 1000;
    expect(COMPACT_TRIGGER_FRAC).toBe(0.8);
    expect(shouldCompact(budget * COMPACT_TRIGGER_FRAC + 1, budget)).toBe(true);
    expect(shouldCompact(budget * COMPACT_TRIGGER_FRAC - 1, budget)).toBe(false);
  });
});

describe('quick-chat FAST_PATH', () => {
  it('fast-paths chitchat, not real goals', () => {
    expect(isQuickChat('hi')).toBe(true);
    expect(isQuickChat('find a wireless mouse under $30')).toBe(false);
  });

  it('does not fast-path short real goals', () => {
    expect(isQuickChat('buy milk')).toBe(false);
    expect(isQuickChat('check gmail')).toBe(false);
  });

  it('matches case/punctuation variants', () => {
    expect(isQuickChat('HI')).toBe(true);
    expect(isQuickChat('Hello!')).toBe(true);
    expect(isQuickChat('thanks?')).toBe(true);
    expect(isQuickChat('  hey  ')).toBe(true);
  });
});
