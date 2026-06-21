import { useEffect, useState } from 'react';
import type { DomainTier, Settings } from '@/shared/messages';
import { sameModel } from '@/shared/messages';
import { extractResumeText } from '../resume';
import { fileToBase64 } from '../file_bytes';
import { Icon } from './Icon';

interface Props {
  settings: Settings;
  installedModels: string[];
  onSave: (patch: Partial<Settings>) => void;
  onTier: (host: string, tier: DomainTier) => void;
  onRefreshModels: () => void;
  extractingProfile: boolean;
  onExtractProfile: (resumeText: string) => void;
  onStoreResume: (payload: { name: string; mime: string; base64: string }) => void;
}

type ModelKey = 'plannerModel' | 'executorModel' | 'evaluatorModel' | 'compactorModel' | 'embeddingModel' | 'visionModel';

const TIERS: DomainTier[] = ['read-only', 'click-only', 'full-action'];

export function SettingsPanel({
  settings,
  installedModels,
  onSave,
  onTier,
  onRefreshModels,
  extractingProfile,
  onExtractProfile,
  onStoreResume,
}: Props) {
  const [local, setLocal] = useState<Settings>(settings);
  const [newHost, setNewHost] = useState('');
  const [newTier, setNewTier] = useState<DomainTier>('read-only');
  const [resumeMsg, setResumeMsg] = useState('');

  useEffect(() => {
    setLocal((s) => ({ ...s, profileJson: settings.profileJson }));
  }, [settings.profileJson]);

  const update = <K extends keyof Settings>(k: K, v: Settings[K]) => setLocal((s) => ({ ...s, [k]: v }));

  const isInstalled = (name: string) =>
    installedModels.length === 0 || installedModels.some((m) => sameModel(m, name));
  const connected = installedModels.length > 0;

  const modelField = (key: ModelKey, label: string) => {
    const value = local[key] as string;
    const known = isInstalled(value);
    return (
      <div className="field" key={key}>
        <div className="row-between">
          <span className="field-label">{label}</span>
          <span className={`model-chip ${known ? 'on' : 'off'}`}>
            <Icon name={known ? 'check' : 'alert'} size={10} /> {known ? 'installed' : 'not pulled'}
          </span>
        </div>
        <input
          list="installed-models"
          value={value}
          onChange={(e) => update(key, e.target.value as Settings[ModelKey])}
          style={!known ? { borderColor: 'var(--warn)' } : undefined}
        />
      </div>
    );
  };

  return (
    <div className="settings">
      {/* Connection */}
      <div className="card setting-group">
        <div className="card-title">
          <Icon name="globe" size={13} /> Connection
        </div>
        <div className="field">
          <span className="field-label">Ollama base URL</span>
          <input value={local.ollamaBaseUrl} onChange={(e) => update('ollamaBaseUrl', e.target.value)} />
        </div>
        <div className="row-between">
          <span className="field-hint">
            <span className={`status-dot ${connected ? 'on' : 'off'}`} style={{ display: 'inline-block', marginRight: 6 }} />
            {connected ? `${installedModels.length} model(s) installed` : 'No models detected — start "ollama serve"'}
          </span>
          <button className="btn btn-sm" onClick={onRefreshModels}>
            <Icon name="spinner" size={12} /> Refresh
          </button>
        </div>
      </div>

      {/* Models */}
      <div className="card setting-group">
        <div className="card-title">
          <Icon name="spark" size={13} /> Models
        </div>
        <datalist id="installed-models">
          {installedModels.map((m) => (
            <option value={m} key={m} />
          ))}
        </datalist>
        {modelField('plannerModel', 'Planner')}
        {modelField('executorModel', 'Executor')}
        {modelField('evaluatorModel', 'Evaluator')}
        {modelField('compactorModel', 'Compactor')}
        {modelField('visionModel', 'Vision (multimodal)')}
        {modelField('embeddingModel', 'Embeddings')}
      </div>

      {/* Profile */}
      <div className="card setting-group">
        <div className="card-title">
          <Icon name="flag" size={13} /> Profile (for filling forms)
        </div>
        <div className="field-hint">
          Upload a résumé (.pdf / .docx / .txt) and the model fills this in — or edit the JSON. The file is
          also stored so the agent can attach it to an application.
        </div>
        <div className="field">
          <input
            type="file"
            accept=".pdf,.docx,.txt,.md,.html"
            disabled={extractingProfile}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              setResumeMsg('Reading file…');
              try {
                const base64 = await fileToBase64(file);
                onStoreResume({ name: file.name, mime: file.type || 'application/octet-stream', base64 });
                const text = await extractResumeText(file);
                if (!text.trim()) {
                  setResumeMsg('Stored the file. No text found to auto-fill (a scanned PDF needs OCR).');
                  return;
                }
                setResumeMsg('Extracting profile with the model…');
                onExtractProfile(text);
              } catch (err) {
                setResumeMsg(`Error: ${(err as Error).message}`);
              }
            }}
          />
          {(resumeMsg || extractingProfile) && (
            <div className="field-hint">{extractingProfile ? 'Extracting profile with the model…' : resumeMsg}</div>
          )}
        </div>
        <div className="field">
          <textarea
            rows={6}
            value={local.profileJson ?? ''}
            onChange={(e) => update('profileJson', e.target.value)}
            placeholder={'{\n  "name": "Jane Doe",\n  "email": "jane@example.com",\n  "phone": "555-0100"\n}'}
            style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}
          />
        </div>
      </div>

      {/* Standing preferences */}
      <div className="card setting-group">
        <div className="card-title">
          <Icon name="plan" size={13} /> Standing preferences
        </div>
        <div className="field-hint">
          Persistent guidance the agent honors on every task (planner, executor, and evaluator) — e.g. "use
          city-proper population, not metro", "prefer official/primary sources", "I'm in the UK: use £ and UK
          results". Stays on your machine.
        </div>
        <div className="field">
          <textarea
            rows={4}
            value={local.preferences ?? ''}
            onChange={(e) => update('preferences', e.target.value)}
            placeholder={'e.g.\n- Use city-proper population, not metro\n- Prefer official or primary sources'}
          />
        </div>
      </div>

      {/* Domain access */}
      <div className="card setting-group">
        <div className="card-title">
          <Icon name="lock" size={13} /> Domain access
        </div>
        <div className="field-hint">
          Unknown hosts are <code>read-only</code>. The agent cannot click or type until you upgrade a host.
        </div>
        {Object.entries(local.domainTiers).map(([host, tier]) => (
          <div className="domain-row" key={host}>
            <input value={host} readOnly />
            <select
              value={tier}
              onChange={(e) => {
                const t = e.target.value as DomainTier;
                onTier(host, t);
                setLocal((s) => ({ ...s, domainTiers: { ...s.domainTiers, [host]: t } }));
              }}
            >
              {TIERS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
        ))}
        <div className="domain-row">
          <input placeholder="example.com" value={newHost} onChange={(e) => setNewHost(e.target.value)} />
          <select value={newTier} onChange={(e) => setNewTier(e.target.value as DomainTier)}>
            {TIERS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button
            className="btn btn-sm"
            onClick={() => {
              const h = newHost.trim().toLowerCase();
              if (!h) return;
              onTier(h, newTier);
              setLocal((s) => ({ ...s, domainTiers: { ...s.domainTiers, [h]: newTier } }));
              setNewHost('');
            }}
          >
            <Icon name="plus" size={12} /> Add
          </button>
        </div>
      </div>

      <div className="save-bar">
        <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => onSave(local)}>
          <Icon name="check" size={14} /> Save settings
        </button>
      </div>
    </div>
  );
}
