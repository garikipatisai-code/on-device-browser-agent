import { describe, expect, it } from 'vitest';
import { buildExecutorMessages, buildPlannerMessages, type CommonContext } from '@/agent/prompts';

const ctx: CommonContext = {
  goal: 'Using Wikipedia, compare the populations of Austin, Seattle, and Denver',
  toolCatalog: '',
  plan: null,
  currentStepId: null,
  ownedTabs: [],
};

describe('information-sufficiency gating (answer from a search snippet, skip the redundant open)', () => {
  it('executor: tells the model to report a fact already in the search snippet instead of opening the result', () => {
    const sys = buildExecutorMessages(ctx)[0].content;
    // mentions the search results/snippet as a source you can answer from…
    expect(sys).toMatch(/snippet|search result/i);
    // …and that you should NOT open_result just to re-confirm a value already shown
    expect(sys).toMatch(/without opening|do ?n.?t open|skip(ping)? the open|need not open|no need to open/i);
  });

  it('executor: still says to open when the value is volatile (prices/stock) or the snippet is insufficient', () => {
    const sys = buildExecutorMessages(ctx)[0].content;
    expect(sys).toMatch(/price|stock|truncat|insufficient|missing|ambiguous|changes? (often|frequently)/i);
  });

  it('planner: lets a per-item step read the fact from its snippet rather than forcing a page open for every item', () => {
    const sys = buildPlannerMessages(ctx)[0].content;
    expect(sys).toMatch(/snippet|search result/i);
    expect(sys).toMatch(/need not open|without opening|does not? have to open|skip/i);
  });

  it('planner: keeps the anti-"giant list/table" guidance (do not regress the per-item structure)', () => {
    const sys = buildPlannerMessages(ctx)[0].content;
    expect(sys).toMatch(/list|table/i);
    expect(sys).toMatch(/each|per[- ]?item|one step per/i);
  });
});
