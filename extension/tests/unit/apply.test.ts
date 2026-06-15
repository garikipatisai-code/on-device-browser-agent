import { describe, expect, it } from 'vitest';
import { buildApplyGoal } from '@/sidepanel/apply';
import { SEED_WORKFLOWS, matchWorkflow } from '@/agent/workflow_memory';

describe('buildApplyGoal', () => {
  it('includes the trimmed URL and the no-submit instruction', () => {
    const g = buildApplyGoal('  https://jobs.lever.co/acme/1  ');
    expect(g).toContain('https://jobs.lever.co/acme/1');
    expect(g).not.toContain('  https');
    expect(g).toMatch(/do not submit/i);
  });

  it('produces a goal that routes to the job-application recipe', () => {
    const wf = matchWorkflow(buildApplyGoal('https://jobs.lever.co/acme/1'), SEED_WORKFLOWS);
    expect(wf?.id).toBe('seed-job-application');
  });
});
