import { describe, expect, it } from 'vitest';
import { scoreWorkflow, traceToWorkflow, type Workflow } from '@/agent/workflow_memory';

const wf = (over: Partial<Workflow>): Workflow => ({
  id: 'x',
  domain: 'amazon.co',
  goalKeywords: ['shop'],
  goalSample: '',
  steps: [],
  ...over,
});

describe('workflow memory — host match + PII (audit gaps)', () => {
  it('host bonus needs exact host or dot-boundary subdomain, not a substring', () => {
    const sub = scoreWorkflow(['shop'], 'amazon.com', wf({ domain: 'amazon.co' }));
    const exact = scoreWorkflow(['shop'], 'amazon.com', wf({ domain: 'amazon.com' }));
    expect(exact).toBeGreaterThan(sub); // 'amazon.co' must NOT get the +0.25 for 'amazon.com'
  });

  it('still grants the bonus to a true subdomain', () => {
    expect(scoreWorkflow(['shop'], 'smile.amazon.com', wf({ domain: 'amazon.com' }))).toBeGreaterThan(
      scoreWorkflow(['shop'], 'smile.amazon.com', wf({ domain: 'other.com' })),
    );
  });

  it('traceToWorkflow redacts PII from the stored goal', () => {
    const trace = [
      { tool: 'tab.open', args: {} },
      { tool: 'aria.extract', args: {} },
      { tool: 'finish', args: {} },
    ];
    const w = traceToWorkflow('id', 'apply, email jdoe@corp.com phone 415-555-1234', 'jobs.example', trace);
    const json = JSON.stringify(w);
    expect(json).not.toContain('jdoe@corp.com');
    expect(json).not.toContain('415-555-1234');
  });
});
