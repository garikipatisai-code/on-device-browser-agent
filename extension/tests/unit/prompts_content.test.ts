import { describe, it, expect } from 'vitest';
import { buildEvaluatorMessages, buildExecutorMessages } from '@/agent/prompts';
import type { Step } from '@/shared/messages';

const ctx = {
  goal: 'compare city populations',
  toolCatalog: '(tools)',
  plan: null,
  currentStepId: null,
  ownedTabs: [],
} as Parameters<typeof buildEvaluatorMessages>[0];
const step = {
  id: 's1',
  description: "find São Paulo's population",
  successCriteria: "São Paulo's population is recorded",
  status: 'active',
} as unknown as Step;

describe('evaluator prompt: judges the active step’s specific datum', () => {
  const sys = buildEvaluatorMessages(ctx, 'last result', step)[0].content as string;
  it('requires THIS step’s specific item, not any data', () => {
    expect(sys).toContain("THIS step's specific item");
    expect(sys).toContain('another city'); // the anti-hand-wave example
  });
  it('requires the reason to name/quote the active step’s value', () => {
    expect(sys).toMatch(/reason[^.]{0,40}quote/i);
  });
  it('still protects earlier-gathered data (no re-fail)', () => {
    expect(sys.toLowerCase()).toContain('earlier turn');
  });
});

describe('executor prompt: page is auto-read after navigation (no redundant re-read)', () => {
  const sys = buildExecutorMessages(ctx)[0].content as string;
  it('states the new page is auto-read and not to re-call wait_loaded/aria.extract', () => {
    expect(sys).toContain('AUTO-READ');
    expect(sys).toMatch(/do NOT call tab\.wait_loaded or aria\.extract again/);
  });
  it('removed the old contradictory "after opening … call tab.wait_loaded, then aria.extract" instruction', () => {
    expect(sys).not.toMatch(/after opening a page call tab\.wait_loaded, then aria\.extract/);
  });
  it('keeps the legitimate in-place re-extract case', () => {
    expect(sys.toLowerCase()).toMatch(/in place|did not navigate|filter|sort/);
  });
});
