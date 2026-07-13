import { useEffect, useState } from 'react';
import type { DomainTier, Settings, Provider, ThinkingLevel, RoleGroupConfig } from '@/shared/messages';
import { sameModel } from '@/shared/messages';
import { migrateLegacyTier } from '@/agent/safety/domain_tiers';
import { clampNumCtx, MIN_NUM_CTX, MAX_NUM_CTX, DEFAULT_NUM_CTX } from '@/agent/budget';
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
  onClearRecipes: () => void;
}

interface Preset {
  label: string;
  desc: string;
  provider: Provider;
  model: string;
  baseUrl?: string;
}

const BRAIN_PRESETS: Preset[] = [
  { label: 'Claude Sonnet 4.6', desc: 'Best agent reasoning', provider: 'anthropic', model: 'claude-sonnet-4-6' },
  { label: 'DeepSeek V4 Pro', desc: 'Cheap reasoning', provider: 'openai-compatible', model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com/v1/chat/completions' },
  { label: 'GPT-5.6', desc: 'OpenAI flagship', provider: 'openai-compatible', model: 'gpt-5.6' },
  { label: 'Gemini 3.2 Pro', desc: 'Google balanced', provider: 'openai-compatible', model: 'gemini-3.2-pro', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' },
];

const BODY_PRESETS: Preset[] = [
  { label: 'DeepSeek V4 Flash', desc: 'Cheapest frontier', provider: 'openai-compatible', model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com/v1/chat/completions' },
  { label: 'Gemini 3.2 Flash', desc: 'Fastest latency', provider: 'openai-compatible', model: 'gemini-3.2-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' },
  { label: 'GPT-5.6 mini', desc: 'Reliable budget', provider: 'openai-compatible', model: 'gpt-5.6-mini' },
  { label: 'Claude Haiku 4.5', desc: 'Anthropic budget', provider: 'anthropic', model: 'claude-haiku-4-5' },
];

const THINKING_LEVELS: { value: ThinkingLevel; label: string }[] = [
  { value: 'off', label: 'Off — fastest, no extended reasoning' },
  { value: 'fast', label: 'Fast — low budget' },
  { value: 'standard', label: 'Standard — balanced' },
  { value: 'full', label: 'Full — deepest reasoning, slowest' },
];

const CLOUD_PROVIDERS: { value: Provider; label: string }[] = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai-compatible', label: 'OpenAI-compatible' },
];

const TIERS: DomainTier[] = ['read-only', 'click-only'];
const OPENAI_COMPATIBLE_DEFAULT_URL = 'https://api.openai.com/v1/chat/completions';

export function SettingsPanel({
  settings,
  installedModels,
  onSave,
  onTier,
  onRefreshModels,
  extractingProfile,
  onExtractProfile,
  onStoreResume,
  onClearRecipes,
}: Props) {
  const [local, setLocal] = useState<Settings>(settings);
  const [newHost, setNewHost] = useState('');
  const [newTier, setNewTier] = useState<DomainTier>('read-only');
  const [resumeMsg, setResumeMsg] = useState('');
  const [recipesCleared, setRecipesCleared] = useState(false);
  // Survive baseUrl across provider round-trips (anthropic has no baseUrl field)
  const [brainBaseUrl, setBrainBaseUrl] = useState(
    local.agent?.brain.provider === 'openai-compatible' ? local.agent.brain.baseUrl ?? OPENAI_COMPATIBLE_DEFAULT_URL : OPENAI_COMPATIBLE_DEFAULT_URL,
  );
  const [bodyBaseUrl, setBodyBaseUrl] = useState(
    local.agent?.body.provider === 'openai-compatible' ? local.agent.body.baseUrl ?? OPENAI_COMPATIBLE_DEFAULT_URL : OPENAI_COMPATIBLE_DEFAULT_URL,
  );

  useEffect(() => {
    setLocal((s) => ({ ...s, profileJson: settings.profileJson }));
  }, [settings.profileJson]);

  const update = <K extends keyof Settings>(k: K, v: Settings[K]) => setLocal((s) => ({ ...s, [k]: v }));

  const patchRole = (seat: 'brain' | 'body', p: Partial<RoleGroupConfig>) => {
    setLocal((s) => {
      const agent = s.agent ?? DEFAULT_ROLE_GROUP();
      return { ...s, agent: { ...agent, [seat]: { ...agent[seat], ...p } } };
    });
  };

  const setProvider = (seat: 'brain' | 'body', prov: Provider) => {
    if (seat === 'brain') setBrainBaseUrl(local.agent?.brain.baseUrl ?? OPENAI_COMPATIBLE_DEFAULT_URL);
    else setBodyBaseUrl(local.agent?.body.baseUrl ?? OPENAI_COMPATIBLE_DEFAULT_URL);
    patchRole(seat, { provider: prov, apiKey: prov === 'ollama' ? undefined : (local.agent?.[seat].apiKey ?? ''), baseUrl: prov === 'openai-compatible' ? (seat === 'brain' ? brainBaseUrl : bodyBaseUrl) : undefined });
  };

  const applyPreset = (seat: 'brain' | 'body', p: Preset) => {
    if (seat === 'brain') setBrainBaseUrl(p.baseUrl ?? OPENAI_COMPATIBLE_DEFAULT_URL);
    else setBodyBaseUrl(p.baseUrl ?? OPENAI_COMPATIBLE_DEFAULT_URL);
    patchRole(seat, { provider: p.provider, model: p.model, apiKey: local.agent?.[seat].apiKey ?? '', baseUrl: p.baseUrl ?? (p.provider === 'openai-compatible' ? OPENAI_COMPATIBLE_DEFAULT_URL : undefined) });
  };

  const isInstalled = (name: string) =>
    installedModels.length === 0 || installedModels.some((m) => sameModel(m, name));
  const connected = installedModels.length > 0;

  const providerRadio = (seat: 'brain' | 'body', current: Provider) => (
    <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
      {(['ollama', 'anthropic', 'openai-compatible'] as Provider[]).map((p) => (
        <label key={p} className="field-hint check-row" style={{ margin: 0 }}>
          <input type="radio" name={`${seat}-provider`} checked={current === p} onChange={() => setProvider(seat, p)} />
          <span style={{ fontSize: 12 }}>{p === 'ollama' ? 'Local' : p === 'anthropic' ? 'Anthropic' : 'OpenAI'}</span>
        </label>
      ))}
    </div>
  );

  const modelChip = (model: string) => {
    const known = isInstalled(model);
    return (
      <span className={`model-chip ${known ? 'on' : 'off'}`} style={{ fontSize: 10, marginLeft: 4 }}>
        <Icon name={known ? 'check' : 'alert'} size={9} /> {known ? 'pulled' : 'not pulled'}
      </span>
    );
  };

  const roleCard = (seat: 'brain' | 'body', title: string, emoji: string, roles: string, presets: Preset[]) => {
    const g = local.agent?.[seat] ?? { provider: 'ollama' as Provider, model: 'gemma4:e4b' };
    const isCloud = g.provider !== 'ollama';
    return (
      <div className="card setting-group" style={{ flex: 1, minWidth: 260 }}>
        <h2 className="card-title">{emoji} {title}</h2>
        <div className="field-hint" style={{ marginBottom: 8 }}>Powers: {roles}</div>
        {/* Presets */}
        <div className="field">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
            {presets.map((p) => (
              <button key={p.label} className="btn btn-sm" title={p.desc}
                onClick={() => applyPreset(seat, p)}
                style={{ fontSize: 10, opacity: g.model === p.model ? 1 : 0.6, borderColor: g.model === p.model ? 'var(--accent)' : undefined }}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
        {/* Provider */}
        <div className="field">
          <label className="field-label">Provider</label>
          {providerRadio(seat, g.provider)}
        </div>
        {/* Model */}
        <div className="field">
          <label className="field-label" htmlFor={`${seat}-model`}>Model {g.provider === 'ollama' ? modelChip(g.model) : null}</label>
          <input id={`${seat}-model`} list="installed-models"
            placeholder={g.provider === 'ollama' ? 'gemma4:e4b' : g.provider === 'anthropic' ? 'claude-opus-4-8' : 'gpt-5.1'}
            value={g.model}
            onChange={(e) => patchRole(seat, { model: e.target.value })} />
        </div>
        {/* Cloud-only fields */}
        {isCloud && (
          <>
            {g.provider === 'openai-compatible' && (
              <div className="field">
                <label className="field-label" htmlFor={`${seat}-cloud-provider`}>Cloud provider</label>
                <select id={`${seat}-cloud-provider`} value={g.provider}
                  onChange={(e) => setProvider(seat, e.target.value as Provider)}>
                  {CLOUD_PROVIDERS.map((cp) => <option key={cp.value} value={cp.value}>{cp.label}</option>)}
                </select>
              </div>
            )}
            {g.provider === 'openai-compatible' && (
              <div className="field">
                <label className="field-label" htmlFor={`${seat}-base-url`}>Base URL</label>
                <input id={`${seat}-base-url`} placeholder={OPENAI_COMPATIBLE_DEFAULT_URL}
                  value={g.baseUrl ?? ''}
                  onChange={(e) => { if (seat === 'brain') setBrainBaseUrl(e.target.value); else setBodyBaseUrl(e.target.value); patchRole(seat, { baseUrl: e.target.value }); }} />
              </div>
            )}
            <div className="field">
              <label className="field-label" htmlFor={`${seat}-api-key`}>API key</label>
              <input id={`${seat}-api-key`} type="password" placeholder="sk-..."
                value={g.apiKey ?? ''}
                onChange={(e) => patchRole(seat, { apiKey: e.target.value })} />
            </div>
          </>
        )}
        {/* Thinking */}
        <div className="field">
          <label className="field-label" htmlFor={`${seat}-thinking`}>Thinking</label>
          <select id={`${seat}-thinking`}
            value={g.thinkingLevel ?? 'off'}
            onChange={(e) => patchRole(seat, { thinkingLevel: e.target.value as ThinkingLevel })}>
            {THINKING_LEVELS.map((tl) => <option key={tl.value} value={tl.value}>{tl.label}</option>)}
          </select>
          <div className="field-hint">
            {g.provider === 'ollama' ? 'Local models ignore this — it only applies to cloud providers.' : 'Controls reasoning depth for this role.'}
          </div>
        </div>
      </div>
    );
  };

  function DEFAULT_ROLE_GROUP(): { brain: RoleGroupConfig; body: RoleGroupConfig } {
    return { brain: { provider: 'ollama', model: 'gemma4:e4b' }, body: { provider: 'ollama', model: 'gemma4:e4b' } };
  }

  return (
    <div className="settings">
      {/* Connection */}
      <div className="card setting-group">
        <h2 className="card-title">
          <Icon name="globe" size={13} /> Connection
        </h2>
        <div className="field">
          <label className="field-label" htmlFor="ollama-base-url">Ollama base URL</label>
          <input id="ollama-base-url" value={local.ollamaBaseUrl} onChange={(e) => update('ollamaBaseUrl', e.target.value)} />
        </div>
        <div className="row-between">
          <span className="field-hint">
            <span className={`status-dot ${connected ? 'on' : 'off'}`} />
            {connected ? `${installedModels.length} model(s) installed` : 'No models detected — start "ollama serve"'}
          </span>
          <button className="btn btn-sm" onClick={onRefreshModels}>
            <Icon name="spinner" size={12} /> Refresh
          </button>
        </div>
      </div>

      {/* Brain & Body model config */}
      <datalist id="installed-models">
        {installedModels.map((m) => (
          <option value={m} key={m} />
        ))}
      </datalist>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {roleCard('brain', 'Brain', '🧠', 'Planner + Evaluator', BRAIN_PRESETS)}
        {roleCard('body', 'Body', '⚡', 'Executor + Compactor', BODY_PRESETS)}
      </div>

      {/* Other models + context window */}
      <div className="card setting-group">
        <h2 className="card-title">
          <Icon name="spark" size={13} /> Other models & memory
        </h2>
        <div className="field">
          <div className="row-between">
            <label className="field-label" htmlFor="vision-model">Vision (multimodal)</label>
            {modelChip(local.visionModel)}
          </div>
          <input id="vision-model" list="installed-models" value={local.visionModel}
            onChange={(e) => update('visionModel', e.target.value)} />
          <div className="field-hint">Used by vision.read and vision.verify for screenshot analysis. Must support images.</div>
        </div>
        <div className="field">
          <div className="row-between">
            <label className="field-label" htmlFor="embedding-model">Embeddings</label>
            {modelChip(local.embeddingModel)}
          </div>
          <input id="embedding-model" list="installed-models" value={local.embeddingModel}
            onChange={(e) => update('embeddingModel', e.target.value)} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="num-ctx">Context window (num_ctx)</label>
          <input
            id="num-ctx"
            type="number"
            value={local.numCtx ?? DEFAULT_NUM_CTX}
            min={MIN_NUM_CTX}
            max={MAX_NUM_CTX}
            step={8192}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              update('numCtx', Number.isFinite(n) ? n : DEFAULT_NUM_CTX);
            }}
            onBlur={() => update('numCtx', clampNumCtx(local.numCtx))}
          />
          <div className="field-hint">
            Larger = better long-task memory but more VRAM. On a 16 GB box, raise in steps (32768 → 65536 → 131072)
            and check <code>ollama ps</code> shows the model at ~100% GPU with no CPU spill after each change. If a
            task fails to start or slows sharply, lower it back.
          </div>
        </div>
      </div>

      {/* Profile */}
      <div className="card setting-group">
        <h2 className="card-title">
          <Icon name="flag" size={13} /> Profile (for filling forms)
        </h2>
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
            className="textarea-mono"
            aria-label="Profile JSON"
            value={local.profileJson ?? ''}
            onChange={(e) => update('profileJson', e.target.value)}
            placeholder={'{\n  "name": "Jane Doe",\n  "email": "jane@example.com",\n  "phone": "555-0100"\n}'}
          />
        </div>
      </div>

      {/* Standing preferences */}
      <div className="card setting-group">
        <h2 className="card-title">
          <Icon name="plan" size={13} /> Standing preferences
        </h2>
        <div className="field-hint">
          Persistent guidance the agent honors on every task (planner, executor, and evaluator) — e.g. "use
          city-proper population, not metro", "prefer official/primary sources", "I'm in the UK: use £ and UK
          results". Stays on your machine.
        </div>
        <div className="field">
          <textarea
            rows={4}
            aria-label="Standing preferences"
            value={local.preferences ?? ''}
            onChange={(e) => update('preferences', e.target.value)}
            placeholder={'e.g.\n- Use city-proper population, not metro\n- Prefer official or primary sources'}
          />
        </div>
        <div className="row-between">
          <span className="field-hint">
            Learned recipes speed up repeat tasks — but a messy one can steer the planner wrong. Forget
            them to let the agent rebuild from clean runs.
          </span>
          <button
            className="btn btn-sm"
            onClick={() => {
              onClearRecipes();
              setRecipesCleared(true);
              setTimeout(() => setRecipesCleared(false), 2000);
            }}
          >
            <Icon name={recipesCleared ? 'check' : 'x'} size={12} /> {recipesCleared ? 'Cleared' : 'Forget learned recipes'}
          </button>
        </div>
      </div>

      {/* Domain access */}
      <div className="card setting-group">
        <h2 className="card-title">
          <Icon name="lock" size={13} /> Domain access
        </h2>
        <div className="field-hint">
          Unknown hosts are <code>read-only</code>. The agent cannot click or type until you upgrade a host.
        </div>
        <label className="field-hint check-row">
          <input
            type="checkbox"
            checked={!!local.bypassDomainTiers}
            onChange={(e) => update('bypassDomainTiers', e.target.checked)}
          />
          <span>
            <strong>Let the agent click, type, and submit on any site</strong> (skip per-site approval). With
            this on, the agent acts on any page without asking — including forms and purchases. Reading is never
            restricted; dangerous URL schemes (file:, chrome:, javascript:) stay blocked.
          </span>
        </label>
        {Object.entries(local.domainTiers).map(([host, tier]) => (
          <div className="domain-row" key={host}>
            <input value={host} readOnly aria-label="Domain" />
            <select
              aria-label={`Access tier for ${host}`}
              value={migrateLegacyTier(tier)}
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
          <input placeholder="example.com" aria-label="New domain" value={newHost} onChange={(e) => setNewHost(e.target.value)} />
          <select aria-label="Access tier for new domain" value={newTier} onChange={(e) => setNewTier(e.target.value as DomainTier)}>
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
