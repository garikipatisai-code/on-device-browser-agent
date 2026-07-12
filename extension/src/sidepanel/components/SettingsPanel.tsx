import { useEffect, useState } from 'react';
import type { DomainTier, FrontierConfig, Settings } from '@/shared/messages';
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

type ModelKey = 'plannerModel' | 'executorModel' | 'evaluatorModel' | 'compactorModel' | 'embeddingModel' | 'visionModel';

interface FrontPreset {
  label: string;
  desc: string;
  provider: FrontierConfig['provider'];
  model: string;
  baseUrl?: string;
  seat: 'lead' | 'helper' | 'both';
}

const LEAD_PRESETS: FrontPreset[] = [
  { label: 'Claude Sonnet 4.6', desc: 'Best agent reasoning', provider: 'anthropic', model: 'claude-sonnet-4-6', seat: 'lead' },
  { label: 'DeepSeek V4 Pro', desc: 'Cheap reasoning', provider: 'openai-compatible', model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com/v1/chat/completions', seat: 'lead' },
  { label: 'GPT-5.6', desc: 'OpenAI flagship', provider: 'openai-compatible', model: 'gpt-5.6', seat: 'lead' },
  { label: 'Gemini 3.2 Pro', desc: 'Google balanced', provider: 'openai-compatible', model: 'gemini-3.2-pro', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', seat: 'lead' },
];

const HELPER_PRESETS: FrontPreset[] = [
  { label: 'DeepSeek V4 Flash', desc: 'Cheapest frontier', provider: 'openai-compatible', model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com/v1/chat/completions', seat: 'helper' },
  { label: 'Gemini 3.2 Flash', desc: 'Fastest latency', provider: 'openai-compatible', model: 'gemini-3.2-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', seat: 'helper' },
  { label: 'GPT-5.6 mini', desc: 'Reliable budget', provider: 'openai-compatible', model: 'gpt-5.6-mini', seat: 'helper' },
  { label: 'Claude Haiku 4.5', desc: 'Anthropic budget', provider: 'anthropic', model: 'claude-haiku-4-5', seat: 'helper' },
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
  // Survives a round-trip through the anthropic provider arm (which has no baseUrl field at
  // all), so exploring the Provider select doesn't silently discard a typed-in openai-compatible
  // endpoint (OpenRouter/DeepSeek/self-hosted). Tracked independently of `local.frontier` itself.
  const [lastBaseUrl, setLastBaseUrl] = useState(
    settings.frontier?.provider === 'openai-compatible' ? settings.frontier.baseUrl : OPENAI_COMPATIBLE_DEFAULT_URL,
  );

  useEffect(() => {
    setLocal((s) => ({ ...s, profileJson: settings.profileJson }));
  }, [settings.profileJson]);

  const update = <K extends keyof Settings>(k: K, v: Settings[K]) => setLocal((s) => ({ ...s, [k]: v }));

  const updateFrontier = (patch: {
    provider?: FrontierConfig['provider'];
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  }) => {
    if (patch.baseUrl !== undefined) setLastBaseUrl(patch.baseUrl);
    setLocal((s) => {
      const provider = patch.provider ?? s.frontier?.provider ?? 'anthropic';
      const apiKey = patch.apiKey ?? s.frontier?.apiKey ?? '';
      const model = patch.model ?? s.frontier?.model ?? '';
      const frontier: FrontierConfig =
        provider === 'anthropic'
          ? { provider, apiKey, model }
          : {
              provider,
              apiKey,
              model,
              baseUrl: patch.baseUrl ?? lastBaseUrl,
            };
      return { ...s, frontier };
    });
  };

  const isInstalled = (name: string) =>
    installedModels.length === 0 || installedModels.some((m) => sameModel(m, name));
  const connected = installedModels.length > 0;

  const modelField = (key: ModelKey, label: string) => {
    const value = local[key] as string;
    const known = isInstalled(value);
    return (
      <div className="field" key={key}>
        <div className="row-between">
          <label className="field-label" htmlFor={key}>{label}</label>
          <span className={`model-chip ${known ? 'on' : 'off'}`}>
            <Icon name={known ? 'check' : 'alert'} size={10} /> {known ? 'installed' : 'not pulled'}
          </span>
        </div>
        <input
          id={key}
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

      {/* Models */}
      <div className="card setting-group">
        <h2 className="card-title">
          <Icon name="spark" size={13} /> Models
        </h2>
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

      {/* Frontier model (optional) */}
      <div className="card setting-group">
        <h2 className="card-title">
          <Icon name="spark" size={13} /> Frontier model (optional)
        </h2>
        <div className="field-hint">
          Use a frontier model for the lead seats (planner, evaluator). The helper seat
          (executor, compactor) always stays local unless you also enable the option below. Off by default.
        </div>
        <label className="field-hint check-row">
          <input
            type="checkbox"
            checked={!!local.hybridMode}
            onChange={(e) => update('hybridMode', e.target.checked)}
          />
          <span>
            <strong>Use a frontier model for planning and evaluation (hybrid mode)</strong>. Calls a
            paid API repeatedly during a run (roughly every 3rd turn) — this app doesn't track or cap
            that spend.
          </span>
        </label>
        {local.hybridMode && (
          <>
            <div className="field">
              <label className="field-label">Quick presets (populates model + URL)</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {(local.hybridHelpers ? [...LEAD_PRESETS, ...HELPER_PRESETS] : LEAD_PRESETS).map((p) => (
                  <button
                    key={p.label}
                    className="btn btn-sm"
                    title={p.desc}
                    onClick={() => updateFrontier({ provider: p.provider, model: p.model, baseUrl: p.baseUrl })}
                    style={{
                      fontSize: 11,
                      opacity: local.frontier?.model === p.model ? 1 : 0.65,
                      borderColor: local.frontier?.model === p.model ? 'var(--accent)' : undefined,
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="frontier-provider">Provider</label>
              <select
                id="frontier-provider"
                value={local.frontier?.provider ?? 'anthropic'}
                onChange={(e) => updateFrontier({ provider: e.target.value as FrontierConfig['provider'] })}
              >
                <option value="anthropic">Anthropic</option>
                <option value="openai-compatible">OpenAI-compatible</option>
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="frontier-model">Model</label>
              <input
                id="frontier-model"
                placeholder={local.frontier?.provider === 'openai-compatible' ? 'gpt-5.1' : 'claude-opus-4-8'}
                value={local.frontier?.model ?? ''}
                onChange={(e) => updateFrontier({ model: e.target.value })}
              />
            </div>
            {local.frontier?.provider === 'openai-compatible' && (
              <div className="field">
                <label className="field-label" htmlFor="frontier-base-url">Base URL</label>
                <input
                  id="frontier-base-url"
                  placeholder={OPENAI_COMPATIBLE_DEFAULT_URL}
                  value={local.frontier.baseUrl}
                  onChange={(e) => updateFrontier({ baseUrl: e.target.value })}
                />
                <div className="field-hint">
                  Examples — OpenRouter: <code>https://openrouter.ai/api/v1/chat/completions</code>; DeepSeek:{' '}
                  <code>https://api.deepseek.com/chat/completions</code>; or any self-hosted/proxy endpoint
                  speaking the same OpenAI Chat Completions shape.
                </div>
              </div>
            )}
            <div className="field">
              <label className="field-label" htmlFor="frontier-api-key">API key</label>
              <input
                id="frontier-api-key"
                type="password"
                placeholder={local.frontier?.provider === 'openai-compatible' ? 'sk-...' : 'sk-ant-...'}
                value={local.frontier?.apiKey ?? ''}
                onChange={(e) => updateFrontier({ apiKey: e.target.value })}
              />
            </div>
          </>
        )}
        <div className="field">
          <label className="field-label" htmlFor="thinking-mode">Thinking (lead seat)</label>
          <select
            id="thinking-mode"
            value={local.leadThinking === undefined ? 'default' : local.leadThinking ? 'on' : 'off'}
            onChange={(e) => {
              const v = e.target.value;
              update('leadThinking', v === 'default' ? undefined : v === 'on');
            }}
          >
            <option value="default">Default (recommended)</option>
            <option value="on">Always on</option>
            <option value="off">Always off</option>
          </select>
          <div className="field-hint">
            Overrides extended thinking for the planner/evaluator seat, on whichever model is serving
            it (local or frontier). Best-effort only on Anthropic and OpenAI itself — DeepSeek,
            MiniMax, OpenRouter-routed models, and self-hosted backends don't have a standardized way
            to control this, so Default and Always on may behave identically there. Leave on Default
            unless you have a specific reason to change it.
          </div>
          <div className="field" style={{ marginTop: 8 }}>
            <label className="field-label" htmlFor="thinking-effort">Thinking effort</label>
            <select
              id="thinking-effort"
              value={local.leadThinkingEffort ?? 'medium'}
              onChange={(e) => update('leadThinkingEffort', e.target.value as 'low' | 'medium' | 'high')}
            >
              <option value="low">Low — fastest, less thorough</option>
              <option value="medium">Medium — balanced</option>
              <option value="high">High — deepest reasoning, slowest</option>
            </select>
            <div className="field-hint">
              How much reasoning effort to spend per planner/evaluator step. Low is faster but may miss
              edge cases. High is more thorough but costs more tokens and time. Only applies when
              thinking is on and the provider supports it (OpenAI, DeepSeek). Anthropic uses its own
              adaptive thinking regardless of this setting.
            </div>
          </div>
          <label className="field-hint check-row" style={{ marginTop: 12 }}>
            <input
              type="checkbox"
              checked={!!local.hybridHelpers}
              onChange={(e) => update('hybridHelpers', e.target.checked)}
            />
            <span>
              <strong>Also run the executor/compactor on the frontier model.</strong> Everything that
              reads pages, clicks, and types goes through the remote API too. Only turn this on for
              tasks where the local model is too slow or unreliable. The whole run uses API tokens.
            </span>
          </label>
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
