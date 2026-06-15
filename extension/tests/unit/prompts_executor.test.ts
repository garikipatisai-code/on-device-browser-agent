import { describe, expect, it } from 'vitest';
import { buildExecutorMessages } from '@/agent/prompts';

describe('executor prompt — job application rules', () => {
  it('instructs résumé upload via the tool and forbids submitting', () => {
    const msgs = buildExecutorMessages({
      goal: 'apply to a job',
      toolCatalog: '',
      plan: null,
      currentStepId: null,
      ownedTabs: [],
    });
    const sys = msgs[0].content;
    expect(sys).toContain('tab.upload_file');
    expect(sys).toMatch(/do not submit/i);
  });
});
