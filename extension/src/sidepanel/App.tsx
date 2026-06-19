import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentStatus,
  MetricsSnapshot,
  PanelCommand,
  Settings,
  SwUpdate,
  TimelineEvent,
} from '@/shared/messages';
import { DEFAULT_SETTINGS } from '@/shared/messages';
import { createPortClient, type PortClient } from './port';
import { Timeline } from './components/Timeline';
import { SettingsPanel } from './components/SettingsPanel';
import { MetricsPanel } from './components/MetricsPanel';

type Tab = 'agent' | 'settings' | 'metrics';

export function App() {
  const [tab, setTab] = useState<Tab>('agent');
  const [goal, setGoal] = useState('');
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
  const [notice, setNotice] = useState<{ msg: string; kind: 'warn' | 'error' } | null>(null);
  const [installedModels, setInstalledModels] = useState<string[]>([]);
  const [extractingProfile, setExtractingProfile] = useState(false);
  const clientRef = useRef<PortClient | null>(null);

  useEffect(() => {
    const c = (globalThis as { chrome?: typeof chrome }).chrome;
    if (!c?.runtime?.connect) {
      setNotice({ msg: 'Running outside Chrome — SW connection unavailable.', kind: 'warn' });
      return;
    }
    const onUpdate = (msg: SwUpdate) => {
      switch (msg.type) {
        case 'status':
          setStatus(msg.status);
          break;
        case 'timeline':
          setEvents(msg.events);
          break;
        case 'append':
          // Mirror the SW's own 1000-event cap so a long task can't grow the panel
          // array unbounded between full 'timeline' resyncs.
          setEvents((prev) => [...prev, msg.event].slice(-1000));
          break;
        case 'settings':
          setSettings(msg.settings);
          break;
        case 'metrics':
          setMetrics(msg.metrics);
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
            setNotice({
              msg: `Preflight failed: ${JSON.stringify(msg.details).slice(0, 200)}`,
              kind: 'warn',
            });
          } else {
            setNotice(null);
          }
          break;
      }
    };
    const client = createPortClient(onUpdate);
    clientRef.current = client;
    client.send({ type: 'settings.get' });
    client.send({ type: 'agent.status' });
    client.send({ type: 'models.list' });
    return () => {
      client.disconnect();
      clientRef.current = null;
    };
  }, []);

  const send = (cmd: PanelCommand) => {
    clientRef.current?.send(cmd);
  };

  const running = status.phase !== 'IDLE' && status.phase !== 'DONE' && status.phase !== 'ABORTED';

  const phaseClass = useMemo(() => {
    if (status.phase === 'ABORTED') return 'error';
    if (status.phase === 'DONE') return 'done';
    if (running) return 'running';
    return '';
  }, [status.phase, running]);

  const handleStart = () => {
    const trimmed = goal.trim();
    if (!trimmed) return;
    setEvents([]);
    setNotice(null);
    send({ type: 'preflight' });
    send({ type: 'agent.start', goal: trimmed });
  };

  const handleAbort = () => send({ type: 'agent.abort' });

  return (
    <div className="app">
      <div className="tabs">
        <button className={`tab ${tab === 'agent' ? 'active' : ''}`} onClick={() => setTab('agent')}>
          Agent
        </button>
        <button className={`tab ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>
          Settings
        </button>
        <button className={`tab ${tab === 'metrics' ? 'active' : ''}`} onClick={() => setTab('metrics')}>
          Metrics
        </button>
      </div>

      {tab === 'agent' && (
        <>
          <div className="goal-row">
            <input
              className="goal-input"
              placeholder="State a goal (e.g. find a wireless mouse under $30)"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              disabled={running}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !running) handleStart();
              }}
            />
            {running ? (
              <button className="btn btn-danger" onClick={handleAbort}>
                Stop
              </button>
            ) : (
              <button className="btn btn-primary" onClick={handleStart} disabled={!goal.trim()}>
                Run
              </button>
            )}
          </div>
          <div className="status-row">
            <span>
              Phase: <span className={`status-phase ${phaseClass}`}>{status.phase}</span>
              {status.replanCount > 0 ? ` · replans: ${status.replanCount}` : ''}
            </span>
            <span>
              Steps:{' '}
              {status.plan
                ? `${status.plan.steps.filter((s) => s.status === 'completed').length}/${
                    status.plan.steps.length
                  }`
                : '—'}
            </span>
          </div>
          {notice && <div className={`notice ${notice.kind}`}>{notice.msg}</div>}
          <Timeline events={events} />
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
        />
      )}

      {tab === 'metrics' && <MetricsPanel metrics={metrics} />}
    </div>
  );
}
