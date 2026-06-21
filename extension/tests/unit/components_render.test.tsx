// Render smoke test: mount every redesigned component to static markup across its key states.
// Can't load the extension in Chrome here, so this verifies render-safety + that each state
// produces the right content (verdict label, phase label, plan steps, event titles, …).
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_SETTINGS, type Plan, type TimelineEvent } from '@/shared/messages';
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
      <Composer running={false} goal="" onGoalChange={noop} onRun={noop} applyUrl="" onApplyUrlChange={noop} onApply={noop} onAskPage={noop} onStop={noop} showExamples />,
    );
    expect(html).toContain('State a goal');
    expect(html).toContain('Run');
    expect(html).toMatch(/Apply to a job/i);
    expect(html).toMatch(/Ask about this page/i);
  });

  it('RunState renders the human phase label + every plan step', () => {
    const html = renderToStaticMarkup(<RunState phase="EXECUTING" plan={plan} elapsedMs={95_000} />);
    expect(html).toContain('Working in the page'); // not the raw "EXECUTING"
    expect(html).not.toContain('EXECUTING');
    expect(html).toContain('Search for the product');
    expect(html).toContain('Report the price');
    expect(html).toContain('1m 35s');
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
      />,
    );
    expect(html).toContain('Connection');
    expect(html).toContain('Models');
    expect(html).toContain('Domain access');
    expect(html).toContain('shop.example');
    expect(html).toContain('Save settings');
  });

  it('MetricsPanel renders the empty state and a populated table', () => {
    expect(renderToStaticMarkup(<MetricsPanel metrics={null} />)).toContain('No metrics yet');
    const html = renderToStaticMarkup(
      <MetricsPanel metrics={{ ops: [{ op: 'planner', n: 4, ok: 4, p50: 1200, mean: 1500 }] }} />,
    );
    expect(html).toContain('planner');
    expect(html).toContain('calls');
  });
});
