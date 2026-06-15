import { useEffect, useState } from 'react';
import type { DomainTier, Settings } from '@/shared/messages';
import { sameModel } from '@/shared/messages';
import { extractResumeText } from '../resume';

interface Props {
  settings: Settings;
  installedModels: string[];
  onSave: (patch: Partial<Settings>) => void;
  onTier: (host: string, tier: DomainTier) => void;
  onRefreshModels: () => void;
  extractingProfile: boolean;
  onExtractProfile: (resumeText: string) => void;
}

type ModelKey = 'plannerModel' | 'executorModel' | 'evaluatorModel' | 'compactorModel' | 'embeddingModel' | 'visionModel';

export function SettingsPanel({
  settings,
  installedModels,
  onSave,
  onTier,
  onRefreshModels,
  extractingProfile,
  onExtractProfile,
}: Props) {
  const [local, setLocal] = useState<Settings>(settings);
  const [newHost, setNewHost] = useState('');
  const [newTier, setNewTier] = useState<DomainTier>('read-only');
  const [resumeMsg, setResumeMsg] = useState('');

  // Sync the profile box when the SW returns an extracted profile (settings prop updates).
  useEffect(() => {
    setLocal((s) => ({ ...s, profileJson: settings.profileJson }));
  }, [settings.profileJson]);

  const update = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setLocal((s) => ({ ...s, [k]: v }));

  const isInstalled = (name: string) =>
    installedModels.length === 0 || installedModels.some((m) => sameModel(m, name));

  const modelField = (key: ModelKey, label: string) => {
    const value = local[key] as string;
    const known = isInstalled(value);
    return (
      <div className="field" key={key}>
        <label>{label}</label>
        <input
          list="installed-models"
          value={value}
          onChange={(e) => update(key, e.target.value as Settings[ModelKey])}
          style={!known ? { borderColor: 'var(--warn)' } : undefined}
        />
        {!known && (
          <div style={{ fontSize: 10, color: 'var(--warn)', marginTop: 2 }}>
            Not in your installed list — pull it or pick one below.
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="settings">
      <div className="section-head">Ollama</div>
      <div className="field">
        <label>Base URL</label>
        <input value={local.ollamaBaseUrl} onChange={(e) => update('ollamaBaseUrl', e.target.value)} />
      </div>

      <div className="section-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Models</span>
        <button className="btn" style={{ padding: '2px 8px', fontSize: 11 }} onClick={onRefreshModels}>
          ↻ Refresh installed
        </button>
      </div>

      {/* Shared autocomplete source: whatever `ollama list` returned. */}
      <datalist id="installed-models">
        {installedModels.map((m) => (
          <option value={m} key={m} />
        ))}
      </datalist>

      <div style={{ fontSize: 11, color: 'var(--fg-mute)', marginBottom: 8 }}>
        {installedModels.length > 0
          ? `${installedModels.length} model(s) installed: ${installedModels.join(', ')}`
          : 'No installed models detected. Start "ollama serve" and click Refresh.'}
      </div>

      {modelField('plannerModel', 'Planner (thinking ON, ~32K ctx)')}
      {modelField('executorModel', 'Executor (thinking OFF, ≤6K ctx)')}
      {modelField('evaluatorModel', 'Evaluator (thinking ON, ~8K ctx)')}
      {modelField('compactorModel', 'Compactor (fast, local only)')}
      {modelField('visionModel', 'Vision (multimodal — reads pages by screenshot)')}
      {modelField('embeddingModel', 'Embeddings')}

      <div className="section-head" style={{ marginTop: 16 }}>Profile (for filling forms)</div>
      <div style={{ fontSize: 11, color: 'var(--fg-mute)', marginBottom: 8 }}>
        Upload a résumé (.pdf / .docx / .txt) and the model fills this in — or edit the JSON directly. Used to auto-fill application forms. Resume file upload into a page isn&apos;t supported yet.
      </div>
      <div className="field">
        <input
          type="file"
          accept=".pdf,.docx,.txt,.md,.html"
          disabled={extractingProfile}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = ''; // allow re-selecting the same file
            if (!file) return;
            setResumeMsg('Reading file…');
            try {
              const text = await extractResumeText(file);
              if (!text.trim()) {
                setResumeMsg('No text found (a scanned PDF needs OCR — not supported).');
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
          <div style={{ fontSize: 11, color: 'var(--fg-mute)', marginTop: 4 }}>
            {extractingProfile ? 'Extracting profile with the model…' : resumeMsg}
          </div>
        )}
      </div>
      <div className="field">
        <textarea
          rows={6}
          value={local.profileJson ?? ''}
          onChange={(e) => update('profileJson', e.target.value)}
          placeholder={'{\n  "name": "Jane Doe",\n  "email": "jane@example.com",\n  "phone": "555-0100",\n  "location": "Austin, TX",\n  "experience": "5 years ..."\n}'}
          style={{ width: '100%', fontFamily: 'monospace', fontSize: 11 }}
        />
      </div>

      <button className="btn btn-primary" onClick={() => onSave(local)}>
        Save settings
      </button>

      <div className="section-head" style={{ marginTop: 24 }}>
        Domain tiers
      </div>
      <div style={{ fontSize: 11, color: 'var(--fg-mute)', marginBottom: 8 }}>
        Unknown hosts default to <code>read-only</code>. The agent cannot click or type until you
        upgrade a domain here.
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
            <option value="read-only">read-only</option>
            <option value="click-only">click-only</option>
            <option value="full-action">full-action</option>
          </select>
        </div>
      ))}
      <div className="domain-row">
        <input placeholder="example.com" value={newHost} onChange={(e) => setNewHost(e.target.value)} />
        <select value={newTier} onChange={(e) => setNewTier(e.target.value as DomainTier)}>
          <option value="read-only">read-only</option>
          <option value="click-only">click-only</option>
          <option value="full-action">full-action</option>
        </select>
        <button
          className="btn"
          onClick={() => {
            const h = newHost.trim().toLowerCase();
            if (!h) return;
            onTier(h, newTier);
            setLocal((s) => ({ ...s, domainTiers: { ...s.domainTiers, [h]: newTier } }));
            setNewHost('');
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}
