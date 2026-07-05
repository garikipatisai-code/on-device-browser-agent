import { describe, expect, it } from 'vitest';
import { describePhase, isRunning } from '@/sidepanel/view/phase';

describe('describePhase', () => {
  it('describes BLOCKED as a busy, attention-needed state', () => {
    const info = describePhase('BLOCKED');
    expect(info.busy).toBe(true);
    expect(info.tone).toBe('error');
    expect(info.label).toMatch(/waiting/i);
  });
});

describe('isRunning', () => {
  it('treats BLOCKED as running (the Stop control should stay visible)', () => {
    expect(isRunning('BLOCKED')).toBe(true);
  });
});
