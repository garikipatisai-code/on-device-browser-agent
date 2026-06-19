import { describe, expect, it } from 'vitest';
import { checkBreaker, newBreakerState, recordAction, resetForNewStep } from '@/agent/safety/circuit_breaker';

describe('circuit breaker — resetForNewStep clears windowed detectors', () => {
  it('a fresh step does not inherit stale unknown-tool flags (no premature storm trip)', () => {
    let s = newBreakerState();
    for (let i = 0; i < 7; i++) s = recordAction(s, `h${i}`, /*unknownTool*/ true, /*found*/ false);
    s = resetForNewStep(s);
    s = recordAction(s, 'fresh', true, false); // one unknown action on the new step
    expect(checkBreaker(s).trip).toBe(false);
  });

  it('a fresh step does not inherit the stale low-diversity window', () => {
    let s = newBreakerState();
    for (let i = 0; i < 10; i++) s = recordAction(s, i % 2 === 0 ? 'a' : 'b', false, false);
    s = resetForNewStep(s);
    s = recordAction(s, 'c', false, false);
    expect(checkBreaker(s).trip).toBe(false);
  });
});
