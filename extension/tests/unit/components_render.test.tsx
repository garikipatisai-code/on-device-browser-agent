// Render smoke test: mount every redesigned component to static markup across its key states.
// Can't load the extension in Chrome here, so this verifies render-safety + that each state
// produces the right content (verdict label, phase label, plan steps, event titles, …).
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_SETTINGS, type Plan, type Settings, type TimelineEvent } from '@/shared/messages';
import { Brand } from '@/sidepanel/components/Brand';
import { Tabs } from '@/sidepanel/components/Tabs';
import { Alert } from '@/sidepanel/components/Alert';
import { ConnectionCard } from '@/sidepanel/components/ConnectionCard';
import { Composer } from '@/sidepanel/components/Composer';
import { RunState } from '@/sidepanel/components/RunState';
import { ResultCard } from '@/sidepanel/components/ResultCard';
import { Timeline } from '@/sidepanel/components/Timeline';
import { SettingsPanel } from '@/sidepanel/components/SettingsPanel';
import { MetricsPanel } from '@/sidepanel/components/MetricsPanel';
import { RecipesPanel } from '@/sidepanel/components/RecipesPanel';
import type { RecipeView } from '@/shared/messages';
import { SessionSwitcher } from '@/sidepanel/components/SessionSwitcher';
import type { Session } from '@/shared/messages';
import { Transcript } from '@/sidepanel/components/Transcript';
import type { SessionTurn } from '@/shared/messages';

const noop = () => undefined;
const plan: Plan = {
  created: 0,
  steps: [
    { id: 'a', description: 'Search for the product', successCriteria: 'results', status: 'completed' },
    { id: 'b', description: 'Open the first result', successCriteria: 'opened', status: 'active' },
    { id: 'c', description: 'Report the price', successCriteria: 'reported', status: 'pending' },
  ],
};

describe('redesigned components render across states', () => {
  it('Brand + Tabs render with the privacy signal and all sections', () => {
    expect(renderToStaticMarkup(<Brand />)).toContain('Local');
    const tabs = renderToStaticMarkup(<Tabs tab="agent" onTab={noop} />);
    expect(tabs).toContain('Agent');
    expect(tabs).toContain('Settings');
    expect(tabs).toContain('Metrics');
  });

  it('Composer renders the goal field, an example chip, and the mode toggles', () => {
    const html = renderToStaticMarkup(
      <Composer running={false} goal="" onGoalChange={noop} onRun={noop} applyUrl="" onApplyUrlChange={noop} onApply={noop} onAskPage={noop} onSteer={noop} onStop={noop} showExamples phase="IDLE" plan={null} eventCount={0} />,
    );
    expect(html).toContain('State a goal');
    expect(html).toContain('Run');
    expect(html).toMatch(/Apply to a job/i);
    expect(html).toMatch(/Ask about this page/i);
    expect(html).not.toMatch(/Steer the running task/i); // steer only appears while running
  });

  it('Composer shows the steer input while a task is running (mid-run redirect)', () => {
    const html = renderToStaticMarkup(
      <Composer running goal="" onGoalChange={noop} onRun={noop} applyUrl="" onApplyUrlChange={noop} onApply={noop} onAskPage={noop} onSteer={noop} onStop={noop} showExamples={false} phase="EXECUTING" plan={null} eventCount={0} />,
    );
    expect(html).toMatch(/Steer the running task/i); // the steer field
    expect(html).toMatch(/Stop/); // and the stop button
  });

  it('Composer surfaces a status line (phase + step fraction + live action count) while running, since RunState scrolls out of view but the composer never does', () => {
    const running_html = renderToStaticMarkup(
      <Composer running goal="" onGoalChange={noop} onRun={noop} applyUrl="" onApplyUrlChange={noop} onApply={noop} onAskPage={noop} onSteer={noop} onStop={noop} showExamples={false} phase="EXECUTING" plan={plan} eventCount={18} />,
    );
    expect(running_html).toContain('Working in the page');
    expect(running_html).toContain('1 of 3 steps');
    expect(running_html).toContain('18 actions');

    const idle_html = renderToStaticMarkup(
      <Composer running={false} goal="" onGoalChange={noop} onRun={noop} applyUrl="" onApplyUrlChange={noop} onApply={noop} onAskPage={noop} onSteer={noop} onStop={noop} showExamples={false} phase="IDLE" plan={plan} eventCount={18} />,
    );
    expect(idle_html).not.toContain('Working in the page');
    expect(idle_html).not.toContain('18 actions');
  });

  it('RunState renders the human phase label + every plan step + the progress meter', () => {
    const html = renderToStaticMarkup(<RunState phase="EXECUTING" plan={plan} elapsedMs={95_000} eventCount={18} />);
    expect(html).toContain('Working in the page'); // not the raw "EXECUTING"
    expect(html).not.toContain('EXECUTING');
    expect(html).toContain('Search for the product');
    expect(html).toContain('Report the price');
    expect(html).toContain('1m 35s');
    expect(html).toContain('1 of 3 steps');
    expect(html).toContain('18 actions'); // live activity count, not just the coarse step fraction
    expect(html).toMatch(/role="progressbar"/);
    expect(html).toMatch(/aria-valuenow="1"/);
    expect(html).toMatch(/aria-valuemax="3"/);
  });

  it('RunState shows no progress meter before a plan exists', () => {
    const html = renderToStaticMarkup(<RunState phase="PLANNING" plan={null} elapsedMs={2_000} eventCount={0} />);
    expect(html).not.toMatch(/role="progressbar"/);
    expect(html).not.toContain('steps');
  });

  it('RunState progress meter is full width with no pulse once every step is resolved', () => {
    const donePlan: Plan = {
      created: 0,
      steps: [
        { id: 'a', description: 'Search for the product', successCriteria: 'results', status: 'completed' },
        { id: 'b', description: 'Open the first result', successCriteria: 'opened', status: 'completed' },
      ],
    };
    const html = renderToStaticMarkup(<RunState phase="EVALUATING" plan={donePlan} elapsedMs={1_000} eventCount={9} />);
    expect(html).toContain('2 of 2 steps');
    expect(html).toContain('9 actions');
    expect(html).toMatch(/aria-valuenow="2"/);
    expect(html).toMatch(/width:100%/);
    expect(html).not.toContain('progress-fill-pulse');
  });

  it('ResultCard heroes the verdict + summary + cites sources', () => {
    const html = renderToStaticMarkup(
      <ResultCard verdict="success" summary="The cheapest mouse is the Logitech M185 at $13.42." steps={3} elapsedMs={42_000} replans={0} sources={['https://shop.example/product']} />,
    );
    expect(html).toContain('Success');
    expect(html).toContain('Logitech M185');
    expect(html).toContain('3 steps');
    expect(html).toContain('Copy');
    expect(html).toContain('shop.example');
  });

  it('ResultCard renders **bold** and literal \\n as formatting, not raw markup', () => {
    const html = renderToStaticMarkup(
      <ResultCard verdict="partial" summary={'Line one.\\n\\n**Seattle** is largest.'} steps={1} elapsedMs={0} replans={0} />,
    );
    expect(html).toContain('<strong>Seattle</strong>'); // bold rendered
    expect(html).not.toContain('**Seattle**'); // raw markdown gone
    expect(html).not.toContain('\\n'); // literal escape normalized away
  });

  it('ResultCard tones partial/blocked/failed correctly', () => {
    expect(renderToStaticMarkup(<ResultCard verdict="partial" summary="x" steps={1} elapsedMs={0} replans={0} />)).toContain('Partial');
    expect(renderToStaticMarkup(<ResultCard verdict="blocked" summary="x" steps={1} elapsedMs={0} replans={0} />)).toContain('Blocked');
    expect(renderToStaticMarkup(<ResultCard verdict="failed" summary="x" steps={1} elapsedMs={0} replans={0} />)).toContain('Failed');
  });

  it('Timeline renders events with human titles when open, nothing when empty', () => {
    const events: TimelineEvent[] = [
      { kind: 'planner.plan', ts: 1, plan },
      { kind: 'tool.call', ts: 2, tool: 'search', args: { query: 'mouse' } },
      { kind: 'finish', ts: 3, verdict: 'success', summary: 'done' },
    ];
    const open = renderToStaticMarkup(<Timeline events={events} open onToggle={noop} />);
    expect(open).toContain('Activity');
    expect(open).toContain('Planned 3 steps');
    expect(open).toContain('search');
    expect(open).toContain('Copy steps'); // labeled (not icon-only) so the steps-copy is unmissable
    expect(renderToStaticMarkup(<Timeline events={[]} open onToggle={noop} />)).toBe('');
  });

  it('Alert renders error + warn', () => {
    expect(renderToStaticMarkup(<Alert kind="error">boom</Alert>)).toContain('boom');
    expect(renderToStaticMarkup(<Alert kind="warn">heads up</Alert>)).toContain('heads up');
  });

  it('the connection-lost banner (Alert reused for a mid-run SW disconnect) renders honest, non-overpromising copy', () => {
    // App.tsx renders exactly this when connectionLost is true — a mid-run SW death is otherwise
    // invisible (the panel would just freeze at the last-received phase with no signal at all).
    // Reconnect is purely reactive (the next send() revives the port) — no background polling — so
    // the copy must not claim an active "reconnecting…" process that isn't actually happening.
    const html = renderToStaticMarkup(
      <Alert kind="warn">Connection to the agent was lost — it will reconnect on your next action.</Alert>,
    );
    expect(html).toMatch(/Connection to the agent was lost/i);
    expect(html).toMatch(/reconnect/i);
    expect(html).not.toMatch(/reconnecting…/i);
  });

  it('ConnectionCard surfaces the down-state with the start command + retry', () => {
    const html = renderToStaticMarkup(<ConnectionCard baseUrl="http://localhost:11434" onRetry={noop} />);
    expect(html).toContain('Ollama');
    expect(html).toMatch(/running/i);
    expect(html).toContain('ollama serve');
    expect(html).toContain('http://localhost:11434');
    expect(html).toMatch(/retry/i);
  });

  it('SettingsPanel renders connection, models, profile, domain sections', () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        settings={{ ...DEFAULT_SETTINGS, domainTiers: { 'shop.example': 'click-only' } }}
        installedModels={[DEFAULT_SETTINGS.executorModel]}
        onSave={noop}
        onTier={noop}
        onRefreshModels={noop}
        extractingProfile={false}
        onExtractProfile={noop}
        onStoreResume={noop}
        onClearRecipes={noop}
      />,
    );
    expect(html).toContain('Connection');
    expect(html).toContain('Models');
    expect(html).toContain('Domain access');
    expect(html).toContain('shop.example');
    expect(html).toContain('Save settings');
    expect(html).toMatch(/Forget learned recipes/i);
  });

  it('SettingsPanel keeps a typed-in frontier baseUrl after a round-trip through the anthropic provider', () => {
    // Regression: switching Provider to anthropic and back to openai-compatible used to
    // silently reset a custom baseUrl (e.g. an OpenRouter/DeepSeek endpoint) back to the
    // hardcoded default, because updateFrontier only remembered the last baseUrl when
    // `frontier` was *currently* shaped as openai-compatible — a detour through the
    // anthropic arm (which has no baseUrl field at all) broke that chain.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const settings: Settings = { ...DEFAULT_SETTINGS, hybridMode: true };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <SettingsPanel
          settings={settings}
          installedModels={[DEFAULT_SETTINGS.executorModel]}
          onSave={noop}
          onTier={noop}
          onRefreshModels={noop}
          extractingProfile={false}
          onExtractProfile={noop}
          onStoreResume={noop}
          onClearRecipes={noop}
        />,
      );
    });

    const fieldValue = (label: string) =>
      [...container.querySelectorAll('.field')]
        .find((f) => f.querySelector('.field-label')?.textContent === label);

    const setSelect = (label: string, value: string) => {
      const select = fieldValue(label)!.querySelector('select') as HTMLSelectElement;
      act(() => {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    };
    // React patches HTMLInputElement.prototype's `value` setter to track "seen" values, so a
    // plain `input.value = x` (which goes through that patched setter) leaves React thinking it
    // already observed this value, and a subsequently dispatched `input` event is a no-op. Go
    // through the native (unpatched) prototype setter instead — same trick testing-library uses.
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    const setInput = (label: string, value: string) => {
      const input = fieldValue(label)!.querySelector('input') as HTMLInputElement;
      act(() => {
        nativeInputValueSetter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    const getInputValue = (label: string) =>
      (fieldValue(label)!.querySelector('input') as HTMLInputElement).value;

    // Switch to openai-compatible, then type a custom baseUrl (OpenRouter's endpoint).
    setSelect('Provider', 'openai-compatible');
    const customUrl = 'https://openrouter.ai/api/v1/chat/completions';
    setInput('Base URL', customUrl);
    expect(getInputValue('Base URL')).toBe(customUrl);

    // Round-trip through anthropic (no baseUrl field exists at all on that arm) and back.
    setSelect('Provider', 'anthropic');
    setSelect('Provider', 'openai-compatible');

    expect(getInputValue('Base URL')).toBe(customUrl);

    act(() => root.unmount());
    container.remove();
  });

  it('MetricsPanel renders the empty state and a populated table', () => {
    expect(renderToStaticMarkup(<MetricsPanel metrics={null} />)).toContain('No metrics yet');
    const html = renderToStaticMarkup(
      <MetricsPanel metrics={{ ops: [{ op: 'planner', n: 4, ok: 4, p50: 1200, mean: 1500 }] }} />,
    );
    expect(html).toContain('planner');
    expect(html).toContain('calls');
  });

  it('RecipesPanel lists recipes, shows the selected one with its planner preview + origin', () => {
    const recipes: RecipeView[] = [
      { id: 'seed-compare', origin: 'builtin', name: 'Compare anything', whenToUse: 'compare several things', site: '*', steps: [{ instruction: 'search each', toolHint: 'search' }], preview: '1. search each  [tool: search]' },
      { id: 'user:1', origin: 'user', name: 'My flow', whenToUse: 'do my thing', site: '*', trusted: false, steps: [{ instruction: 'step a' }], preview: '1. step a' },
    ];
    const html = renderToStaticMarkup(<RecipesPanel recipes={recipes} onRefresh={noop} onSave={noop} onDelete={noop} />);
    expect(html).toContain('Recipes');
    expect(html).toContain('Compare anything'); // first recipe selected by default
    expect(html).toContain('[tool: search]'); // the live planner preview is shown
    expect(html).toMatch(/Built-in/); // origin label
    expect(html).toMatch(/New/); // the author-new affordance
  });

  it('SessionSwitcher shows "New chat" when nothing is active, and lists past sessions once one exists', () => {
    const noneActive = renderToStaticMarkup(
      <SessionSwitcher sessions={[]} activeSessionId={null} onNew={noop} onSelect={noop} onDelete={noop} />,
    );
    expect(noneActive).toContain('New chat');

    const sessions: Session[] = [
      { id: 's1', title: 'find the population of Austin', createdAt: 1, lastActiveAt: 2, turns: [] },
      { id: 's2', title: 'compare two laptops', createdAt: 3, lastActiveAt: 4, turns: [] },
    ];
    const html = renderToStaticMarkup(
      <SessionSwitcher sessions={sessions} activeSessionId="s1" onNew={noop} onSelect={noop} onDelete={noop} />,
    );
    expect(html).toContain('find the population of Austin');
    expect(html).toContain('compare two laptops');
    expect(html).toMatch(/Delete/i); // active session has a delete affordance
  });

  it('Transcript renders each past turn as goal + verdict + summary, and nothing when empty', () => {
    expect(renderToStaticMarkup(<Transcript turns={[]} />)).toBe('');

    const turns: SessionTurn[] = [
      { taskId: 't1', goal: 'find the population of Austin', verdict: 'success', summary: 'Austin has **961,855** residents.' },
      { taskId: 't2', goal: 'now do Seattle too' }, // no result yet — still mid-run or never finished
    ];
    const html = renderToStaticMarkup(<Transcript turns={turns} />);
    expect(html).toContain('find the population of Austin');
    expect(html).toContain('Success');
    expect(html).toContain('<strong>961,855</strong>');
    expect(html).toContain('now do Seattle too');
    expect(html).not.toMatch(/now do Seattle too[\s\S]*verdict/); // t2 has no result — no verdict/summary block should render for it
  });
});
