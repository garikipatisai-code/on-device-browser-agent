import { describe, expect, it } from 'vitest';
import type { Plan, TaskPhase, TimelineEvent } from '@/shared/messages';
import { describePhase, isRunning } from '@/sidepanel/view/phase';
import { describeVerdict, formatElapsed } from '@/sidepanel/view/format';
import { latestFinish, planProgress } from '@/sidepanel/view/result';

describe('view/phase', () => {
  it('gives every TaskPhase a human label + tone, and marks the working ones busy', () => {
    const phases: TaskPhase[] = ['IDLE', 'PLANNING', 'EXECUTING', 'EVALUATING', 'COMPACTING', 'ABORTED', 'DONE'];
    for (const p of phases) {
      const info = describePhase(p);
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.label).not.toBe(p); // not the raw enum
      expect(['idle', 'busy', 'done', 'error']).toContain(info.tone);
    }
    expect(describePhase('EXECUTING').busy).toBe(true);
    expect(describePhase('PLANNING').busy).toBe(true);
    expect(describePhase('DONE').busy).toBe(false);
    expect(describePhase('IDLE').busy).toBe(false);
    expect(describePhase('DONE').tone).toBe('done');
    expect(describePhase('ABORTED').tone).toBe('error');
  });

  it('isRunning is true only for the active phases', () => {
    expect(isRunning('PLANNING')).toBe(true);
    expect(isRunning('EXECUTING')).toBe(true);
    expect(isRunning('EVALUATING')).toBe(true);
    expect(isRunning('COMPACTING')).toBe(true);
    expect(isRunning('IDLE')).toBe(false);
    expect(isRunning('DONE')).toBe(false);
    expect(isRunning('ABORTED')).toBe(false);
  });
});

describe('view/format', () => {
  it('formatElapsed renders seconds, then m ss', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(4200)).toBe('4s');
    expect(formatElapsed(59_000)).toBe('59s');
    expect(formatElapsed(60_000)).toBe('1m 00s');
    expect(formatElapsed(95_000)).toBe('1m 35s');
    expect(formatElapsed(-50)).toBe('0s'); // never negative
  });

  it('describeVerdict maps verdicts to label + tone', () => {
    expect(describeVerdict('success')).toEqual({ label: 'Success', tone: 'ok' });
    expect(describeVerdict('partial')).toEqual({ label: 'Partial', tone: 'warn' });
    expect(describeVerdict('blocked')).toEqual({ label: 'Blocked', tone: 'warn' });
    expect(describeVerdict('failed')).toEqual({ label: 'Failed', tone: 'error' });
    expect(describeVerdict('aborted')).toEqual({ label: 'Stopped', tone: 'mute' });
    // unknown verdict degrades gracefully (no crash, shows something)
    expect(describeVerdict('weird').label.length).toBeGreaterThan(0);
  });
});

describe('view/result', () => {
  const finish = (verdict: string, summary: string): TimelineEvent => ({ kind: 'finish', ts: 1, verdict, summary });
  const log = (message: string): TimelineEvent => ({ kind: 'log', ts: 1, level: 'info', message });

  it('latestFinish returns the most recent finish event, or null', () => {
    expect(latestFinish([])).toBeNull();
    expect(latestFinish([log('hi')])).toBeNull();
    expect(latestFinish([finish('partial', 'old'), log('x'), finish('success', 'new')])).toEqual({
      verdict: 'success',
      summary: 'new',
      sources: [],
    });
  });

  it('latestFinish carries source citations when present', () => {
    const withSrc: TimelineEvent = { kind: 'finish', ts: 2, verdict: 'success', summary: 'done', sources: ['https://shop.example/p'] };
    expect(latestFinish([withSrc])?.sources).toEqual(['https://shop.example/p']);
  });

  it('planProgress counts done + locates the active step', () => {
    expect(planProgress(null)).toEqual({ total: 0, done: 0, activeIndex: -1 });
    const plan: Plan = {
      created: 0,
      steps: [
        { id: 'a', description: 'x', successCriteria: 'x', status: 'completed' },
        { id: 'b', description: 'y', successCriteria: 'y', status: 'active' },
        { id: 'c', description: 'z', successCriteria: 'z', status: 'pending' },
      ],
    };
    expect(planProgress(plan)).toEqual({ total: 3, done: 1, activeIndex: 1 });
  });
});
