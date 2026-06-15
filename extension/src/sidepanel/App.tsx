import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentStatus,
  MetricsSnapshot,
  PanelCommand,
  Settings,
  SwUpdate,
  TimelineEvent,
} from '@/shared/messages';
import { DEFAULT_SETTINGS, PORT_NAME } from '@/shared/messages';
import { Timeline } from './components/Timeline';
import { SettingsPanel } from './components/SettingsPanel';
import { MetricsPanel } from './components/MetricsPanel';
import { buildApplyGoal } from './apply';

type Tab = 'agent' | 'settings' | 'metrics';

export function App() {
  const [tab, setTab] = useState<Tab>('agent');
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
  const [notice, setNotice] = useState<{ msg: string; kind: 'warn' | 'error' } | null>(null);
  const [installedModels, setInstalledModels] = useState<string[]>([]);
  const [extractingProfile, setExtractingProfile] = useState(false);
  const portRef = useRef<chrome.runtime.Port | null>(null);

  useEffect(() => {
    const c = (globalThis as { chrome?: typeof chrome }).chrome;
    if (!c?.runtime?.connect) {
      setNotice({ msg: 'Running outside Chrome — SW connection unavailable.', kind: 'warn' });
      return;
    }
    const port = c.runtime.connect({ name: PORT_NAME });
    portRef.current = port;
    const send = (cmd: PanelCommand) => port.postMessage(cmd);
    port.onMessage.addListener((msg: SwUpdate) => {
      switch (msg.type) {
        case 'status':
          setStatus(msg.status);
          break;
        case 'timeline':
          setEvents(msg.events);
          break;
        case 'append':
          setEvents((prev) => [...prev, msg.event]);
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
        case 'resumeStored':
          if (msg.ok) {
            setNotice({ msg: `Résumé "${msg.name}" stored — the agent can attach it to applications.`, kind: 'warn' });
          } else {
            setNotice({ msg: msg.error ?? 'Could not store the résumé file.', kind: 'error' });
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
    });
    port.onDisconnect.addListener(() => {
      portRef.current = null;
    });
    send({ type: 'settings.get' });
    send({ type: 'agent.status' });
    send({ type: 'models.list' });
    return () => {
      try {
        port.disconnect();
      } catch {
        /* noop */
      }
    };
  }, []);

  const send = (cmd: PanelCommand) => {
    portRef.current?.postMessage(cmd);
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

  const handleApply = () => {
    const u = applyUrl.trim();
    if (!u) return;
    const g = buildApplyGoal(u);
    setGoal(g);
    setEvents([]);
    setNotice(null);
    send({ type: 'preflight' });
    send({ type: 'agent.start', goal: g });
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
          <div className="apply-row" style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <input
              className="goal-input"
              placeholder="Apply to a job: paste a Greenhouse/Lever job URL"
              value={applyUrl}
              onChange={(e) => setApplyUrl(e.target.value)}
              disabled={running}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !running) handleApply();
              }}
            />
            <button className="btn" onClick={handleApply} disabled={running || !applyUrl.trim()}>
              Apply
            </button>
          </div>
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
          onStoreResume={(payload) => send({ type: 'resume.store', ...payload })}
        />
      )}

      {tab === 'metrics' && <MetricsPanel metrics={metrics} />}
    </div>
  );
}
