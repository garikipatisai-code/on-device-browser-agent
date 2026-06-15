import { describe, expect, it } from 'vitest';
import {
  checkBreaker,
  newBreakerState,
  recordAction,
  resetForNewStep,
} from '@/agent/safety/circuit_breaker';

describe('circuit_breaker — action-repeat', () => {
  it('trips after 3 consecutive identical actions', () => {
    let s = newBreakerState();
    s = recordAction(s, 'tab.click({1})', false, false);
    s = recordAction(s, 'tab.click({1})', false, false);
    s = recordAction(s, 'tab.click({1})', false, false);
    const v = checkBreaker(s);
    expect(v.trip).toBe(true);
    expect(v.reason).toBe('action-repeat');
  });
  it('does not trip if interleaved', () => {
    let s = newBreakerState();
    s = recordAction(s, 'a', false, false);
    s = recordAction(s, 'b', false, false);
    s = recordAction(s, 'a', false, false);
    const v = checkBreaker(s);
    expect(v.trip).toBe(false);
  });
});

describe('circuit_breaker — low-diversity', () => {
  it('trips on A/B alternation through full window', () => {
    let s = newBreakerState();
    for (let i = 0; i < 10; i++) s = recordAction(s, i % 2 === 0 ? 'a' : 'b', false, false);
    const v = checkBreaker(s);
    expect(v.trip).toBe(true);
    expect(v.reason).toBe('low-diversity');
  });
  it('does not trip with 3+ distinct actions', () => {
    let s = newBreakerState();
    const acts = ['a', 'b', 'c', 'a', 'b', 'c', 'a', 'b', 'c', 'a'];
    // Periodic findings keep the no-progress counter from independently tripping.
    for (let i = 0; i < acts.length; i++) {
      s = recordAction(s, acts[i], false, /*foundFinding=*/ i % 2 === 0);
    }
    const v = checkBreaker(s);
    expect(v.trip).toBe(false);
  });
});

describe('circuit_breaker — unknown-tool storm', () => {
  it('trips on 3 unknown-tool flags in last 8', () => {
    let s = newBreakerState();
    s = recordAction(s, 'bogus.a', true, false);
    s = recordAction(s, 'bogus.b', true, false);
    s = recordAction(s, 'tab.click', false, false);
    s = recordAction(s, 'bogus.c', true, false);
    const v = checkBreaker(s);
    expect(v.trip).toBe(true);
    expect(v.reason).toBe('unknown-tool-storm');
  });
});

describe('circuit_breaker — no-progress', () => {
  it('trips after N turns without findings', () => {
    let s = newBreakerState();
    for (let i = 0; i < 8; i++) s = recordAction(s, `act${i}`, false, false);
    const v = checkBreaker(s);
    expect(v.trip).toBe(true);
    expect(v.reason).toBe('no-progress');
  });
  it('resets counter on new finding', () => {
    let s = newBreakerState();
    for (let i = 0; i < 7; i++) s = recordAction(s, `act${i}`, false, false);
    s = recordAction(s, 'act-new', false, true);
    const v = checkBreaker(s);
    expect(v.trip).toBe(false);
  });
});

describe('resetForNewStep', () => {
  it('clears consecutive repeats and no-progress counters', () => {
    let s = newBreakerState();
    s = recordAction(s, 'x', false, false);
    s = recordAction(s, 'x', false, false);
    s = recordAction(s, 'x', false, false);
    const reset = resetForNewStep(s);
    expect(reset.consecutiveRepeats).toBe(0);
    expect(reset.turnsSinceLastFinding).toBe(0);
  });
});
