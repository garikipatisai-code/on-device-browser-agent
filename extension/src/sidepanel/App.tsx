import { useEffect, useRef, useState } from 'react';
import type {
  AgentStatus,
  MetricsSnapshot,
  PanelCommand,
  RecipeView,
  Session,
  Settings,
  SwUpdate,
  TimelineEvent,
} from '@/shared/messages';
import { DEFAULT_SETTINGS } from '@/shared/messages';
import { createPortClient, type PortClient } from './port';
import { buildApplyGoal } from './apply';
import { isRunning } from './view/phase';
import { latestFinish } from './view/result';
import { Brand } from './components/Brand';
import { Tabs, type TabId } from './components/Tabs';
import { Composer } from './components/Composer';
import { SessionSwitcher } from './components/SessionSwitcher';
import { Transcript } from './components/Transcript';
import { RunState } from './components/RunState';
import { ResultCard } from './components/ResultCard';
import { Timeline } from './components/Timeline';
import { Alert } from './components/Alert';
import { ConnectionCard } from './components/ConnectionCard';
import { Icon } from './components/Icon';
import { SettingsPanel } from './components/SettingsPanel';
import { MetricsPanel } from './components/MetricsPanel';
import { RecipesPanel } from './components/RecipesPanel';

export function App() {
  const [tab, setTab] = useState<TabId>('agent');
  const [goal, setGoal] = useState('');
  const [applyUrl, setApplyUrl] = useState('');
  const [status, setStatus] = useState<AgentStatus>({
    phase: 'IDLE',
    goal: null,
    plan: null,
    currentStepId: null,
    replanCount: 0,
    ownedTabs: [],
  });
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [recipes, setRecipes] = useState<RecipeView[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ msg: string; kind: 'warn' | 'error' } | null>(null);
  const [installedModels, setInstalledModels] = useState<string[]>([]);
  const [extractingProfile, setExtractingProfile] = useState(false);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [activityOpen, setActivityOpen] = useState(false);
  const [ollamaDown, setOllamaDown] = useState(false);
  // True from the moment the SW port disconnects mid-run until the next update arrives (the
  // already-working lazy-reconnect in port.ts revives the connection on the next send() — this
  // only makes that gap visible instead of the panel silently freezing at the last-seen phase).
  const [connectionLost, setConnectionLost] = useState(false);
  const clientRef = useRef<PortClient | null>(null);

  // ---- SW connection (contract: do not change message shapes) ----
  useEffect(() => {
    const c = (globalThis as { chrome?: typeof chrome }).chrome;
    if (!c?.runtime?.connect) {
      setNotice({ msg: 'Running outside Chrome — SW connection unavailable.', kind: 'warn' });
      return;
    }
    const onUpdate = (msg: SwUpdate) => {
      setConnectionLost(false); // any message proves the connection is alive again
      switch (msg.type) {
        case 'status':
          setStatus(msg.status);
          break;
        case 'timeline':
          setEvents(msg.events);
          break;
        case 'append':
          setEvents((prev) => [...prev, msg.event].slice(-1000));
          break;
        case 'settings':
          setSettings(msg.settings);
          break;
        case 'metrics':
          setMetrics(msg.metrics);
          break;
        case 'recipes':
          setRecipes(msg.recipes);
          break;
        case 'sessions':
          setSessions(msg.sessions);
          setActiveSessionId(msg.activeSessionId);
          break;
        case 'models':
          if (msg.ok) {
            setInstalledModels(msg.models);
            if (msg.models.length === 0) {
              setNotice({ msg: 'Ollama is running but has no models pulled yet.', kind: 'warn' });
            }
          } else {
            setInstalledModels([]);
            setNotice({ msg: msg.error ?? 'Could not list models.', kind: 'warn' });
          }
          break;
        case 'error':
          setNotice({ msg: msg.message, kind: 'error' });
          break;
        case 'profileExtracted':
          setExtractingProfile(false);
          if (msg.ok && msg.profileJson) {
            setSettings((prev) => ({ ...prev, profileJson: msg.profileJson }));
            setNotice({ msg: 'Profile extracted from résumé — review it under Settings and Save.', kind: 'warn' });
          } else {
            setNotice({ msg: msg.error ?? 'Profile extraction failed.', kind: 'error' });
          }
          break;
        case 'preflight':
          if (!msg.ok) {
            const d = (msg.details ?? {}) as { error?: string; hint?: string };
            // "Ollama unreachable" is the launch-time case the ConnectionCard handles (start it +
            // auto-reconnect). Other preflight failures (e.g. missing models) stay a normal notice.
            if (/unreachable/i.test(d.error ?? '')) {
              setOllamaDown(true);
            } else {
              setOllamaDown(false);
              setNotice({ msg: d.error ? `${d.error}${d.hint ? ` — ${d.hint}` : ''}` : 'Preflight failed.', kind: 'warn' });
            }
          } else {
            setOllamaDown(false);
            setNotice(null);
          }
          break;
      }
    };
    const client = createPortClient(onUpdate);
    clientRef.current = client;
    client.onDisconnect(() => setConnectionLost(true));
    client.send({ type: 'settings.get' });
    client.send({ type: 'agent.status' });
    client.send({ type: 'models.list' });
    client.send({ type: 'session.list' });
    client.send({ type: 'preflight' }); // connection check on launch → surface the down-state immediately
    return () => {
      client.disconnect();
      clientRef.current = null;
    };
  }, []);

  const send = (cmd: PanelCommand) => clientRef.current?.send(cmd);
  const running = isRunning(status.phase);

  // Tick the elapsed clock once a second while a run is active; freeze it when it ends.
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  // Surface the live activity automatically when a run starts.
  useEffect(() => {
    if (running) setActivityOpen(true);
  }, [running]);

  // Session switches only ever happen while nothing is running (background guards session.select/
  // session.new/session.delete-of-active against a live task), so it's safe to hard-reset the
  // single-turn display the moment activeSessionId changes — this is what makes it structurally
  // impossible to show turn data from the wrong session.
  const prevSessionId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (prevSessionId.current === undefined) {
      prevSessionId.current = activeSessionId; // first update on mount — nothing to reset yet
      return;
    }
    if (prevSessionId.current !== activeSessionId) {
      prevSessionId.current = activeSessionId;
      setEvents([]);
      setNotice(null);
      setRunStartedAt(null);
    }
  }, [activeSessionId]);

  // While Ollama is down, poll the connection so the panel reconnects on its own the moment the
  // user starts `ollama serve` — no click needed. (The extension can't launch the process itself.)
  useEffect(() => {
    if (!ollamaDown) return;
    const id = setInterval(() => clientRef.current?.send({ type: 'preflight' }), 3500);
    return () => clearInterval(id);
  }, [ollamaDown]);

  const handleRetry = () => send({ type: 'preflight' });

  const handleStart = () => {
    const trimmed = goal.trim();
    if (!trimmed) return;
    setEvents([]);
    setNotice(null);
    setRunStartedAt(Date.now());
    send({ type: 'agent.start', goal: trimmed });
  };

  const handleApply = () => {
    const u = applyUrl.trim();
    if (!u) return;
    const g = buildApplyGoal(u);
    setGoal(g);
    setEvents([]);
    setNotice(null);
    setRunStartedAt(Date.now());
    send({ type: 'agent.start', goal: g });
  };

  const handleAskPage = (question: string) => {
    if (!question.trim()) return;
    setEvents([]);
    setNotice(null);
    setRunStartedAt(Date.now());
    send({ type: 'agent.askPage', question: question.trim() });
  };

  const handleAbort = () => send({ type: 'agent.abort' });
  const handleSteer = (text: string) => send({ type: 'agent.steer', text });

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const pastTurns = (activeSession?.turns ?? []).slice(0, -1);
  const lastTurn = activeSession?.turns.at(-1);
  // Prefer live events (the turn just ran in THIS panel session); fall back to the session
  // record's own copy for a turn that finished in a previous panel session (events not in memory).
  const finish = latestFinish(events) ?? (lastTurn?.summary != null
    ? { verdict: lastTurn.verdict ?? '', summary: lastTurn.summary, sources: [] }
    : null);
  const elapsedMs = runStartedAt ? Math.max(0, now - runStartedAt) : 0;
  const stepCount = status.plan?.steps.length ?? null;
  const showEmpty = !running && events.length === 0 && pastTurns.length === 0 && !finish;

  return (
    <div className="app">
      <Brand />
      <Tabs tab={tab} onTab={setTab} />

      <div className="content" role="tabpanel">
        {connectionLost && (
          <Alert kind="warn">Connection to the agent was lost — it will reconnect on your next action.</Alert>
        )}

        {tab === 'agent' && (
          <>
            {ollamaDown && <ConnectionCard baseUrl={settings.ollamaBaseUrl} onRetry={handleRetry} />}

            <SessionSwitcher
              sessions={sessions}
              activeSessionId={activeSessionId}
              onNew={() => send({ type: 'session.new' })}
              onSelect={(id) => send({ type: 'session.select', sessionId: id })}
              onDelete={(id) => send({ type: 'session.delete', sessionId: id })}
            />

            <Composer
              running={running}
              goal={goal}
              onGoalChange={setGoal}
              onRun={handleStart}
              applyUrl={applyUrl}
              onApplyUrlChange={setApplyUrl}
              onApply={handleApply}
              onAskPage={handleAskPage}
              onSteer={handleSteer}
              onStop={handleAbort}
              showExamples={events.length === 0 && status.phase === 'IDLE'}
            />

            {notice && !ollamaDown && <Alert kind={notice.kind}>{notice.msg}</Alert>}

            <Transcript turns={pastTurns} />

            {running && <RunState phase={status.phase} plan={status.plan} elapsedMs={elapsedMs} />}

            {!running && finish && (
              <ResultCard
                verdict={finish.verdict}
                summary={finish.summary}
                steps={stepCount}
                elapsedMs={elapsedMs}
                replans={status.replanCount}
                sources={finish.sources}
              />
            )}

            {showEmpty ? (
              <div className="empty">
                <div className="empty-mark">
                  <Icon name="spark" size={22} />
                </div>
                <div className="empty-title">Ready when you are</div>
                <div className="empty-text">
                  State a goal and I'll handle the browsing — planning, reading pages, and reporting the
                  answer. Everything runs on your machine.
                </div>
              </div>
            ) : (
              <Timeline events={events} open={activityOpen} onToggle={() => setActivityOpen((o) => !o)} />
            )}
          </>
        )}

        {tab === 'settings' && (
          <SettingsPanel
            settings={settings}
            installedModels={installedModels}
            onSave={(patch) => send({ type: 'settings.set', settings: patch })}
            onTier={(host, tier) => send({ type: 'domainTier.set', host, tier })}
            onRefreshModels={() => send({ type: 'models.list' })}
            extractingProfile={extractingProfile}
            onExtractProfile={(resumeText) => {
              setExtractingProfile(true);
              setNotice(null);
              send({ type: 'profile.extract', resumeText });
            }}
            onStoreResume={(payload) => send({ type: 'resume.store', ...payload })}
            onClearRecipes={() => send({ type: 'recipes.clear' })}
          />
        )}

        {tab === 'recipes' && (
          <RecipesPanel
            recipes={recipes}
            onRefresh={() => send({ type: 'recipes.list' })}
            onSave={(input) => send({ type: 'recipes.save', input })}
            onDelete={(id) => send({ type: 'recipes.delete', id })}
          />
        )}

        {tab === 'metrics' && <MetricsPanel metrics={metrics} />}
      </div>
    </div>
  );
}
