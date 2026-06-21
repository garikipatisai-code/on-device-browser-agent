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

// Mid-task "steer": the user corrects a running task without aborting it; the correction must
// surface as high-priority guidance on the next executor turn (and on any replan).
describe('steer guidance injection (Hermes-inspired interrupt-and-redirect)', () => {
  it('executor: surfaces a mid-task steer as guidance the model must follow', () => {
    const user = buildExecutorMessages({ ...ctx, steerNotes: ['search each city separately'] }).find(
      (m) => m.role === 'user',
    )!.content;
    expect(user).toMatch(/guidance|steer/i);
    expect(user).toContain('search each city separately');
  });

  it('executor: no guidance block when there are no steer notes', () => {
    const user = buildExecutorMessages(ctx).find((m) => m.role === 'user')!.content;
    expect(user).not.toMatch(/USER GUIDANCE/);
  });

  it('planner: also surfaces steer notes so a replan honors the correction', () => {
    const user = buildPlannerMessages({ ...ctx, steerNotes: ['use each city-proper figure'] }).find(
      (m) => m.role === 'user',
    )!.content;
    expect(user).toContain('use each city-proper figure');
  });
});

// Standing preferences: durable, user-edited guidance injected into EVERY run (Hermes USER.md,
// scoped safely — user-controlled, not 4B auto-curated).
describe('standing preferences injection', () => {
  it('executor: surfaces standing preferences as guidance to honor', () => {
    const user = buildExecutorMessages({ ...ctx, preferences: 'Always use city-proper population figures.' }).find(
      (m) => m.role === 'user',
    )!.content;
    expect(user).toMatch(/preference/i);
    expect(user).toContain('Always use city-proper population figures.');
  });

  it('planner: surfaces standing preferences too', () => {
    const user = buildPlannerMessages({ ...ctx, preferences: 'Prefer official / primary sources.' }).find(
      (m) => m.role === 'user',
    )!.content;
    expect(user).toContain('Prefer official / primary sources.');
  });

  it('no preferences block when empty', () => {
    const user = buildExecutorMessages(ctx).find((m) => m.role === 'user')!.content;
    expect(user).not.toMatch(/STANDING PREFERENCES/);
  });
});

// The list-page trap: a COMBINED query ("Austin Seattle Denver population") returns a ranked
// "List of…" page a 4B can't read row-by-row. Per-item queries put each fact in its own snippet.
describe('per-item search queries (avoid the combined-query list-page trap)', () => {
  it('planner: search ONE item per query, never a combined query', () => {
    const sys = buildPlannerMessages(ctx)[0].content;
    expect(sys).toMatch(/one item per query/i);
    expect(sys).toMatch(/combined query|never .*combin/i);
  });

  it('executor: search just the one item, not all of them at once', () => {
    const sys = buildExecutorMessages(ctx)[0].content;
    expect(sys).toMatch(/one item per query|search just that item/i);
    expect(sys).toMatch(/list|ranking/i);
  });
});
