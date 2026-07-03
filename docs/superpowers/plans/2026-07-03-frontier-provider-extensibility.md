# Frontier Provider Extensibility + Thinking Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the frontier lead-seat (head-chef/sous-chef) point at any OpenAI Chat-Completions-compatible provider (OpenAI, OpenRouter, DeepSeek, MiniMax, self-hosted) in addition to Anthropic, and let a user override extended-thinking behavior for that seat regardless of which provider serves it.

**Architecture:** Extends `agent/framework/provider.ts` with a second frontier provider function (`openAICompatibleProvider`) dispatched alongside the existing `frontierProvider` via a small `frontierProviderFor` switch, and a composable `withThinkingOverride` wrapper (same shape as the existing `withFallback`) that forces `ChatOptions.thinking` before delegating to whichever provider `resolveLeadProvider` resolves. `Settings['frontier']` becomes a discriminated union to carry the new provider's `baseUrl`.

**Tech Stack:** TypeScript, Vitest (mocked `fetch` via `vi.stubGlobal`), React (Settings UI) — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-03-frontier-provider-extensibility-design.md`

**Task order note (post-execution fix):** Task 2 (Settings UI) was originally written last, right before final verification. It was moved to run immediately after Task 1 because it only depends on Task 1's `FrontierConfig` type — not on any of the provider-layer runtime code built in the tasks that used to precede it. The old `SettingsPanel.tsx`'s `updateFrontier` helper spreads `s.frontier` into an object literal in a way that only type-checked against the *old*, non-union `frontier` shape; once Task 1 lands, that file fails `npm run typecheck` until its own task runs. Moving it up keeps every single commit in this plan typecheck-clean, instead of leaving the tree red for five tasks in a row.

---

### Task 1: Widen `Settings['frontier']` to a discriminated union + add `leadThinking`

**Files:**
- Modify: `extension/src/shared/messages.ts:28-60`

This task is pure type surface — there's no runtime behavior to red/green test yet (that starts in Task 3). The acceptance check is the type checker itself: the new union's `anthropic` arm is structurally identical to today's only shape, so every existing literal `{provider:'anthropic', apiKey, model}` object in the codebase must still satisfy it without changes.

- [x] **Step 1: Replace the `Settings` interface's `frontier` field with a named discriminated union type, and add `leadThinking`**

Current content (lines 28-60):

```ts
export type DomainTier = 'read-only' | 'click-only';

export interface Settings {
  ollamaBaseUrl: string;
  plannerModel: string;
  executorModel: string;
  evaluatorModel: string;
  compactorModel: string;
  embeddingModel: string;
  visionModel: string;
  domainTiers: Record<string, DomainTier>;
  /** Opt-in escape hatch: when true, the agent may click/type/submit on ANY site (the domain-tier
   *  gate is skipped). The blocked-protocol list (file:/chrome:/javascript:/…) still applies.
   *  Default false — safe by default. */
  bypassDomainTiers?: boolean;
  /** JSON object of the user's data (name, email, etc.) used to fill application
   *  forms. Injected into the Executor context; never invented by the model. */
  profileJson?: string;
  /** Durable, user-edited standing guidance injected into every run (planner/executor/evaluator),
   *  e.g. "use city-proper population figures" or "prefer official sources". */
  preferences?: string;
  /** Ollama context window; default 32768, raise only after verifying VRAM with `ollama ps`. */
  numCtx?: number;
  /** Master toggle: when true, the head-chef and sous-chef seats (planner,
   *  evaluator) may run on the configured frontier model instead of local
   *  Ollama. The helper seat (executor, compactor) always stays local. */
  hybridMode?: boolean;
  frontier?: {
    provider: 'anthropic';
    apiKey: string;
    model: string;
  };
}
```

Replace with:

```ts
export type DomainTier = 'read-only' | 'click-only';

/** A persisted frontier config for the lead seat. 'anthropic' is Claude's own
 *  Messages API; 'openai-compatible' is any backend speaking the OpenAI Chat
 *  Completions shape — OpenAI itself, OpenRouter, DeepSeek, MiniMax, or a
 *  self-hosted server — distinguished only by baseUrl/model, never new code. */
export type FrontierConfig =
  | { provider: 'anthropic'; apiKey: string; model: string }
  | { provider: 'openai-compatible'; apiKey: string; model: string; baseUrl: string };

export interface Settings {
  ollamaBaseUrl: string;
  plannerModel: string;
  executorModel: string;
  evaluatorModel: string;
  compactorModel: string;
  embeddingModel: string;
  visionModel: string;
  domainTiers: Record<string, DomainTier>;
  /** Opt-in escape hatch: when true, the agent may click/type/submit on ANY site (the domain-tier
   *  gate is skipped). The blocked-protocol list (file:/chrome:/javascript:/…) still applies.
   *  Default false — safe by default. */
  bypassDomainTiers?: boolean;
  /** JSON object of the user's data (name, email, etc.) used to fill application
   *  forms. Injected into the Executor context; never invented by the model. */
  profileJson?: string;
  /** Durable, user-edited standing guidance injected into every run (planner/executor/evaluator),
   *  e.g. "use city-proper population figures" or "prefer official sources". */
  preferences?: string;
  /** Ollama context window; default 32768, raise only after verifying VRAM with `ollama ps`. */
  numCtx?: number;
  /** Master toggle: when true, the head-chef and sous-chef seats (planner,
   *  evaluator) may run on the configured frontier model instead of local
   *  Ollama. The helper seat (executor, compactor) always stays local. */
  hybridMode?: boolean;
  frontier?: FrontierConfig;
  /** Overrides extended-thinking for the lead seat (head-chef/sous-chef) on
   *  whichever provider serves it. undefined = today's unchanged per-role
   *  defaults; true/false forces it either way, regardless of provider. */
  leadThinking?: boolean;
}
```

Do not touch `DEFAULT_SETTINGS` — it already omits `frontier` entirely (stays `undefined`), and `leadThinking` should be omitted the same way (undefined by default).

- [x] **Step 2: Run typecheck to verify the widened type is backward compatible**

Run: `cd extension && npm run typecheck`
Expected: PASS against everything **except** `sidepanel/components/SettingsPanel.tsx` — that file's pre-existing `updateFrontier` helper spreads the old flat `frontier` shape and will fail to typecheck against the new union until Task 2 (next) replaces it. Confirm the *only* error is in `SettingsPanel.tsx`; anything else is a real problem, stop and report it.

- [x] **Step 3: Commit**

```bash
git add extension/src/shared/messages.ts
git commit -m "feat(settings): widen frontier config to a discriminated union, add leadThinking"
```

---

### Task 2: Settings UI — provider select, base URL field, thinking select

**Files:**
- Modify: `extension/src/sidepanel/components/SettingsPanel.tsx`

This task depends only on Task 1's `FrontierConfig` type — nothing here calls into the provider-layer functions built in later tasks. It's placed here (not at the end) specifically to keep typecheck green immediately after Task 1, since the *existing* `updateFrontier` helper is what breaks once `frontier` becomes a union.

- [ ] **Step 1: Update imports and add the default-URL constant**

Current top of file:

```tsx
import { useEffect, useState } from 'react';
import type { DomainTier, Settings } from '@/shared/messages';
import { sameModel } from '@/shared/messages';
import { migrateLegacyTier } from '@/agent/safety/domain_tiers';
import { clampNumCtx, MIN_NUM_CTX, MAX_NUM_CTX, DEFAULT_NUM_CTX } from '@/agent/budget';
import { extractResumeText } from '../resume';
import { fileToBase64 } from '../file_bytes';
import { Icon } from './Icon';
```

Replace the second line:

```tsx
import { useEffect, useState } from 'react';
import type { DomainTier, FrontierConfig, Settings } from '@/shared/messages';
import { sameModel } from '@/shared/messages';
import { migrateLegacyTier } from '@/agent/safety/domain_tiers';
import { clampNumCtx, MIN_NUM_CTX, MAX_NUM_CTX, DEFAULT_NUM_CTX } from '@/agent/budget';
import { extractResumeText } from '../resume';
import { fileToBase64 } from '../file_bytes';
import { Icon } from './Icon';
```

Then find the module-level constant:

```tsx
const TIERS: DomainTier[] = ['read-only', 'click-only'];
```

Add a sibling constant right after it:

```tsx
const TIERS: DomainTier[] = ['read-only', 'click-only'];
const OPENAI_COMPATIBLE_DEFAULT_URL = 'https://api.openai.com/v1/chat/completions';
```

- [ ] **Step 2: Replace `updateFrontier` to handle the discriminated union**

Current:

```tsx
  const updateFrontier = (patch: Partial<NonNullable<Settings['frontier']>>) =>
    setLocal((s) => ({
      ...s,
      frontier: {
        provider: 'anthropic',
        apiKey: '',
        model: '',
        ...s.frontier,
        ...patch,
      },
    }));
```

Replace with:

```tsx
  const updateFrontier = (patch: {
    provider?: FrontierConfig['provider'];
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  }) => {
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
              baseUrl: patch.baseUrl ?? (s.frontier?.provider === 'openai-compatible' ? s.frontier.baseUrl : OPENAI_COMPATIBLE_DEFAULT_URL),
            };
      return { ...s, frontier };
    });
  };
```

(A plain `Partial<FrontierConfig>` won't work here — `Partial` of a union type only keeps the keys common to *every* arm, so `baseUrl` would be silently dropped from the patch type entirely, and this is exactly the shape of bug that broke Task 1's typecheck against the *old* `updateFrontier`. The explicit object type above avoids that trap.)

- [ ] **Step 3: Replace the "Frontier model (optional)" card**

Current card (from `{/* Frontier model (optional) */}` through the closing `</div>` right before the `<div className="save-bar">`):

```tsx
      {/* Frontier model (optional) */}
      <div className="card setting-group">
        <div className="card-title">
          <Icon name="spark" size={13} /> Frontier model (optional)
        </div>
        <div className="field-hint">
          Let the planner and evaluator use a frontier model instead of the local one. Everything
          else (reading pages, clicking, typing) always stays local. Off by default.
        </div>
        <label className="field-hint" style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 8 }}>
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
              <span className="field-label">Model</span>
              <input
                placeholder="claude-opus-4-8"
                value={local.frontier?.model ?? ''}
                onChange={(e) => updateFrontier({ model: e.target.value })}
              />
            </div>
            <div className="field">
              <span className="field-label">API key</span>
              <input
                type="password"
                placeholder="sk-ant-..."
                value={local.frontier?.apiKey ?? ''}
                onChange={(e) => updateFrontier({ apiKey: e.target.value })}
              />
            </div>
          </>
        )}
      </div>
```

Replace with:

```tsx
      {/* Frontier model (optional) */}
      <div className="card setting-group">
        <div className="card-title">
          <Icon name="spark" size={13} /> Frontier model (optional)
        </div>
        <div className="field-hint">
          Let the planner and evaluator use a frontier model instead of the local one. Everything
          else (reading pages, clicking, typing) always stays local. Off by default.
        </div>
        <label className="field-hint" style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 8 }}>
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
              <span className="field-label">Provider</span>
              <select
                value={local.frontier?.provider ?? 'anthropic'}
                onChange={(e) => updateFrontier({ provider: e.target.value as FrontierConfig['provider'] })}
              >
                <option value="anthropic">Anthropic</option>
                <option value="openai-compatible">OpenAI-compatible</option>
              </select>
            </div>
            <div className="field">
              <span className="field-label">Model</span>
              <input
                placeholder={local.frontier?.provider === 'openai-compatible' ? 'gpt-5.1' : 'claude-opus-4-8'}
                value={local.frontier?.model ?? ''}
                onChange={(e) => updateFrontier({ model: e.target.value })}
              />
            </div>
            {local.frontier?.provider === 'openai-compatible' && (
              <div className="field">
                <span className="field-label">Base URL</span>
                <input
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
              <span className="field-label">API key</span>
              <input
                type="password"
                placeholder={local.frontier?.provider === 'openai-compatible' ? 'sk-...' : 'sk-ant-...'}
                value={local.frontier?.apiKey ?? ''}
                onChange={(e) => updateFrontier({ apiKey: e.target.value })}
              />
            </div>
          </>
        )}
        <div className="field">
          <span className="field-label">Thinking (lead seat)</span>
          <select
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
        </div>
      </div>
```

Note the Thinking field sits *outside* the `{local.hybridMode && (...)}` block — it's always visible in this card, since it affects local-only mode too.

- [ ] **Step 4: Run typecheck and build**

Run: `cd extension && npm run typecheck && npm run build`
Expected: Both PASS with no errors — this also confirms Task 1's typecheck gap is now fully closed, with no errors anywhere in the tree.

- [ ] **Step 5: Manual verification note**

No automated component test exists for `SettingsPanel.tsx` today (consistent with the parent spec's equivalent task) — verification here is typecheck + build + a live browser click-through, same as the parent spec's precedent. If a live browser check isn't achievable in your environment, say so explicitly rather than skipping the note.

- [ ] **Step 6: Commit**

```bash
git add extension/src/sidepanel/components/SettingsPanel.tsx
git commit -m "feat(settings-ui): add provider select, base URL field, and thinking override select"
```

---

### Task 3: `frontierProvider` — honor `opts.thinking` instead of ignoring it

**Files:**
- Modify: `extension/src/agent/framework/provider.ts`
- Test: `extension/tests/unit/framework_provider.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these two `it` blocks inside the existing `describe('frontierProvider', ...)` block in `extension/tests/unit/framework_provider.test.ts`, right after the existing `'throws a status-bearing error on a non-2xx response'` test (before the closing `});` of that `describe`):

```ts
  it('sends thinking:disabled when opts.thinking is explicitly false', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'ok' }], usage: {} }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = frontierProvider({ provider: 'anthropic', apiKey: 'sk-test', model: 'claude-opus-4-8' });
    await provider.chatOnce({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'x' }], thinking: false });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.thinking).toEqual({ type: 'disabled' });
    vi.unstubAllGlobals();
  });

  it('sends thinking:adaptive when opts.thinking is true or omitted', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'ok' }], usage: {} }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = frontierProvider({ provider: 'anthropic', apiKey: 'sk-test', model: 'claude-opus-4-8' });
    await provider.chatOnce({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'x' }], thinking: true });
    await provider.chatOnce({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'x' }] }); // omitted
    const body1 = JSON.parse(fetchMock.mock.calls[0][1].body);
    const body2 = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body1.thinking).toEqual({ type: 'adaptive' });
    expect(body2.thinking).toEqual({ type: 'adaptive' });
    vi.unstubAllGlobals();
  });
```

- [ ] **Step 2: Run the tests to verify the first one fails**

Run: `cd extension && npx vitest run tests/unit/framework_provider.test.ts -t "sends thinking"`
Expected: The `disabled` test FAILS (`thinking` is currently always `{type:'adaptive'}` regardless of input). The `adaptive` test PASSES already — that's expected, it documents behavior the fix must preserve, not behavior it introduces.

- [ ] **Step 3: Fix `frontierProvider` to honor `opts.thinking`**

In `extension/src/agent/framework/provider.ts`, find `frontierProvider`'s current body:

```ts
export function frontierProvider(cfg: FrontierConfig): ModelProvider {
  return {
    async chatOnce(opts: ChatOptions): Promise<ChatResponse> {
      const { system, messages } = splitSystem(opts.messages);
      const body: Record<string, unknown> = {
        model: cfg.model,
        max_tokens: 4096,
        messages,
        thinking: { type: 'adaptive' },
      };
      if (system) body.system = system;
```

Replace with:

```ts
export function frontierProvider(cfg: Extract<FrontierConfig, { provider: 'anthropic' }>): ModelProvider {
  return {
    async chatOnce(opts: ChatOptions): Promise<ChatResponse> {
      const { system, messages } = splitSystem(opts.messages);
      const body: Record<string, unknown> = {
        model: cfg.model,
        max_tokens: 4096,
        messages,
        thinking: { type: opts.thinking === false ? 'disabled' : 'adaptive' },
      };
      if (system) body.system = system;
```

(The parameter type narrows from the full `FrontierConfig` union to just its `anthropic` arm — this function only ever handles that shape; Task 4 makes callers pass the right arm.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && npx vitest run tests/unit/framework_provider.test.ts`
Expected: All tests in this file PASS, including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add extension/src/agent/framework/provider.ts extension/tests/unit/framework_provider.test.ts
git commit -m "fix(framework): frontierProvider now honors opts.thinking instead of always forcing adaptive"
```

---

### Task 4: Add `openAICompatibleProvider` + `normalizeOpenAIResponse`

**Files:**
- Modify: `extension/src/agent/framework/provider.ts`
- Test: `extension/tests/unit/framework_provider.test.ts`

- [ ] **Step 1: Write the failing tests**

Add this new `describe` block to `extension/tests/unit/framework_provider.test.ts`, after the closing `});` of the `describe('frontierProvider', ...)` block and before `describe('withFallback', ...)`:

```ts
describe('openAICompatibleProvider', () => {
  it('translates a request and returns the text response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'the answer' } }],
        usage: { prompt_tokens: 12, completion_tokens: 8 },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = openAICompatibleProvider({
      provider: 'openai-compatible',
      apiKey: 'sk-oa-test',
      model: 'gpt-5.1',
      baseUrl: 'https://api.openai.com/v1/chat/completions',
    });
    const res = await provider.chatOnce({
      model: 'gpt-5.1',
      messages: [
        { role: 'system', content: 'You are the PLANNER' },
        { role: 'user', content: 'plan this' },
      ],
    });

    expect(res.rawText).toBe('the answer');
    expect(res.promptEvalCount).toBe(12);
    expect(res.evalCount).toBe(8);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers.authorization).toBe('Bearer sk-oa-test');
    expect(init.headers['content-type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('gpt-5.1');
    expect(body.max_tokens).toBe(4096);
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are the PLANNER' },
      { role: 'user', content: 'plan this' },
    ]);
    expect(body.reasoning_effort).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it('sends reasoning_effort only when opts.thinking is true', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = openAICompatibleProvider({
      provider: 'openai-compatible', apiKey: 'sk-x', model: 'gpt-5.1', baseUrl: 'https://x/chat/completions',
    });
    await provider.chatOnce({ model: 'gpt-5.1', messages: [{ role: 'user', content: 'x' }], thinking: true });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.reasoning_effort).toBe('high');
    vi.unstubAllGlobals();
  });

  it('throws on a refusal field in the response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { refusal: 'policy' } }] }),
    }));
    const provider = openAICompatibleProvider({
      provider: 'openai-compatible', apiKey: 'sk-x', model: 'gpt-5.1', baseUrl: 'https://x/chat/completions',
    });
    await expect(
      provider.chatOnce({ model: 'gpt-5.1', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow(/declined/);
    vi.unstubAllGlobals();
  });

  it('throws a status-bearing error on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => 'rate limited' }));
    const provider = openAICompatibleProvider({
      provider: 'openai-compatible', apiKey: 'sk-x', model: 'gpt-5.1', baseUrl: 'https://x/chat/completions',
    });
    await expect(
      provider.chatOnce({ model: 'gpt-5.1', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ status: 429 });
    vi.unstubAllGlobals();
  });
});
```

Update this file's import line from:

```ts
import { localProvider, frontierProvider, withFallback, resolveLeadProvider } from '@/agent/framework/provider';
```

to:

```ts
import { localProvider, frontierProvider, openAICompatibleProvider, withFallback, resolveLeadProvider } from '@/agent/framework/provider';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npx vitest run tests/unit/framework_provider.test.ts -t "openAICompatibleProvider"`
Expected: FAIL — `openAICompatibleProvider` is not exported yet (import error / `undefined is not a function`).

- [ ] **Step 3: Implement `openAICompatibleProvider` + `normalizeOpenAIResponse`, and fix the `FrontierConfig` re-export**

In `extension/src/agent/framework/provider.ts`, change the top import (line 4) from:

```ts
import type { Settings } from '@/shared/messages';
```

to:

```ts
import type { FrontierConfig, Settings } from '@/shared/messages';
```

Then find the existing type declaration:

```ts
// Reuse Settings['frontier'] rather than defining a second, structurally-identical
// interface — provider.ts already imports Settings for resolveLeadProvider below.
export type FrontierConfig = NonNullable<Settings['frontier']>;
```

Replace with (the type now lives in `shared/messages.ts` since the Settings UI needs it too — this file just re-exports it so existing `import {FrontierConfig} from '@/agent/framework/provider'` usages keep working):

```ts
// FrontierConfig is defined in shared/messages.ts (the Settings UI needs it
// too) — re-exported here so existing importers of provider.ts's own
// FrontierConfig keep working unchanged.
export type { FrontierConfig };
```

Then, immediately after the existing `safeText` function (which ends with a lone `}` followed by a blank line, right before the `/** Composes at the resolution layer...` doc comment above `withFallback`), insert:

```ts
export function openAICompatibleProvider(cfg: Extract<FrontierConfig, { provider: 'openai-compatible' }>): ModelProvider {
  return {
    async chatOnce(opts: ChatOptions): Promise<ChatResponse> {
      const body: Record<string, unknown> = {
        model: cfg.model,
        max_tokens: 4096,
        messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
      };
      if (opts.thinking === true) body.reasoning_effort = 'high';

      const { signal, cleanup } = composeSignal(opts.timeoutMs ?? 120_000, opts.signal);
      try {
        const res = await fetch(cfg.baseUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify(body),
          signal,
        });
        if (!res.ok) throw frontierHttpError(res.status, await safeText(res));
        return normalizeOpenAIResponse(await res.json());
      } finally {
        cleanup();
      }
    },
  };
}

function normalizeOpenAIResponse(json: Record<string, unknown>): ChatResponse {
  const choice = (json.choices as Array<{ message?: { content?: string; refusal?: string } }> | undefined)?.[0];
  if (choice?.message?.refusal) throw new Error(`Frontier model declined the request (${choice.message.refusal})`);
  const text = choice?.message?.content ?? '';
  const usage = json.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  return {
    message: { role: 'assistant', content: text },
    done: true,
    promptEvalCount: usage?.prompt_tokens,
    evalCount: usage?.completion_tokens,
    toolCalls: [],
    rawText: text,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && npx vitest run tests/unit/framework_provider.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Run typecheck**

Run: `cd extension && npm run typecheck`
Expected: PASS. (This also confirms the Task 1 → Task 4 type-flow is coherent end to end.)

- [ ] **Step 6: Commit**

```bash
git add extension/src/agent/framework/provider.ts extension/tests/unit/framework_provider.test.ts
git commit -m "feat(framework): add openAICompatibleProvider (OpenAI, OpenRouter, DeepSeek, MiniMax, self-hosted)"
```

---

### Task 5: Dispatch between providers by `cfg.provider`, wire into `resolveLeadProvider`

**Files:**
- Modify: `extension/src/agent/framework/provider.ts`
- Test: `extension/tests/unit/framework_provider.test.ts`

- [ ] **Step 1: Write the failing test**

Add this `it` block inside the existing `describe('resolveLeadProvider', ...)` block, after its last existing test:

```ts
  it('resolves to the openai-compatible provider (not Anthropic) when configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'hi' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const fake = makeFakeOllama({});
    const p = resolveLeadProvider(
      {
        ...DEFAULT_SETTINGS,
        hybridMode: true,
        frontier: { provider: 'openai-compatible', apiKey: 'sk-x', model: 'gpt-5.1', baseUrl: 'https://api.openai.com/v1/chat/completions' },
      },
      fake,
    );
    await p.chatOnce({ model: 'gpt-5.1', messages: [{ role: 'user', content: 'hi' }] });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
    vi.unstubAllGlobals();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd extension && npx vitest run tests/unit/framework_provider.test.ts -t "resolves to the openai-compatible provider"`
Expected: FAIL. `resolveLeadProvider` currently calls `frontierProvider(settings.frontier)` unconditionally, which sends the request to Anthropic's hardcoded URL regardless of `cfg.provider` — the assertion on the OpenAI URL fails (and/or the request body/headers are Anthropic-shaped, not OpenAI-shaped).

- [ ] **Step 3: Add the dispatcher and wire it in**

In `extension/src/agent/framework/provider.ts`, immediately before the doc comment above `resolveLeadProvider` (`/** Resolved once per run for the head-chef and sous-chef seats...`), insert:

```ts
function frontierProviderFor(cfg: FrontierConfig): ModelProvider {
  return cfg.provider === 'anthropic' ? frontierProvider(cfg) : openAICompatibleProvider(cfg);
}

```

Then find the current `resolveLeadProvider` body:

```ts
export function resolveLeadProvider(
  settings: Settings,
  ollama: OllamaClient,
  onFallback?: (reason: string) => void,
): ModelProvider {
  if (!settings.hybridMode || !settings.frontier?.apiKey) return localProvider(ollama);
  return withFallback(frontierProvider(settings.frontier), localProvider(ollama), onFallback);
}
```

Replace the last line only:

```ts
export function resolveLeadProvider(
  settings: Settings,
  ollama: OllamaClient,
  onFallback?: (reason: string) => void,
): ModelProvider {
  if (!settings.hybridMode || !settings.frontier?.apiKey) return localProvider(ollama);
  return withFallback(frontierProviderFor(settings.frontier), localProvider(ollama), onFallback);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && npx vitest run tests/unit/framework_provider.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/src/agent/framework/provider.ts extension/tests/unit/framework_provider.test.ts
git commit -m "feat(framework): dispatch resolveLeadProvider's frontier branch by cfg.provider"
```

---

### Task 6: Add `withThinkingOverride`, compose it into `resolveLeadProvider`

**Files:**
- Modify: `extension/src/agent/framework/provider.ts`
- Test: `extension/tests/unit/framework_provider.test.ts`

- [ ] **Step 1: Write the failing tests**

Add this new `describe` block after the closing `});` of `describe('withFallback', ...)` and before `describe('resolveLeadProvider', ...)`:

```ts
describe('withThinkingOverride', () => {
  it('passes through the exact same provider reference when override is undefined', async () => {
    const inner = { chatOnce: vi.fn().mockResolvedValue({ message: { role: 'assistant', content: 'ok' }, done: true, toolCalls: [], rawText: 'ok' }) };
    const provider = withThinkingOverride(inner, undefined);
    expect(provider).toBe(inner); // true no-op, not a functionally-equivalent wrapper
    await provider.chatOnce({ model: 'x', messages: [], thinking: false });
    expect(inner.chatOnce).toHaveBeenCalledWith({ model: 'x', messages: [], thinking: false });
  });

  it('forces opts.thinking to the override value', async () => {
    const inner = { chatOnce: vi.fn().mockResolvedValue({ message: { role: 'assistant', content: 'ok' }, done: true, toolCalls: [], rawText: 'ok' }) };
    const provider = withThinkingOverride(inner, true);
    await provider.chatOnce({ model: 'x', messages: [], thinking: false });
    expect(inner.chatOnce).toHaveBeenCalledWith({ model: 'x', messages: [], thinking: true });
  });
});
```

Also add this `it` block inside the existing `describe('resolveLeadProvider', ...)` block, after its last test:

```ts
  it('composes leadThinking over the local branch even when hybridMode is off', async () => {
    const captured: Array<{ thinking?: boolean }> = [];
    const fake = {
      chatOnce: async (opts: { thinking?: boolean }) => {
        captured.push(opts);
        return { message: { role: 'assistant', content: 'ok' }, done: true, toolCalls: [], rawText: 'ok' };
      },
    } as unknown as OllamaClient;
    const p = resolveLeadProvider({ ...DEFAULT_SETTINGS, hybridMode: false, leadThinking: true }, fake);
    await p.chatOnce({ model: 'x', messages: [], thinking: false });
    expect(captured[0].thinking).toBe(true);
  });
```

This new test needs `OllamaClient` as a type. Update this file's top import from:

```ts
import { localProvider, frontierProvider, openAICompatibleProvider, withFallback, resolveLeadProvider } from '@/agent/framework/provider';
```

to also import the type (add a second import line right below it):

```ts
import { localProvider, frontierProvider, openAICompatibleProvider, withFallback, resolveLeadProvider } from '@/agent/framework/provider';
import type { OllamaClient } from '@/background/ollama';
```

And update the provider import to also bring in `withThinkingOverride`:

```ts
import { localProvider, frontierProvider, openAICompatibleProvider, withFallback, withThinkingOverride, resolveLeadProvider } from '@/agent/framework/provider';
import type { OllamaClient } from '@/background/ollama';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npx vitest run tests/unit/framework_provider.test.ts -t "withThinkingOverride"`
Expected: FAIL — `withThinkingOverride` is not exported yet.

Run: `cd extension && npx vitest run tests/unit/framework_provider.test.ts -t "composes leadThinking"`
Expected: FAIL — `resolveLeadProvider` doesn't read `settings.leadThinking` yet, so `captured[0].thinking` is `false` (the caller's original value), not the expected `true`.

- [ ] **Step 3: Implement `withThinkingOverride` and compose it into `resolveLeadProvider`**

In `extension/src/agent/framework/provider.ts`, immediately after the `describeFallbackReason` function (the last helper belonging to `withFallback`, right before the doc comment above `frontierProviderFor` from Task 5), insert:

```ts
export function withThinkingOverride(provider: ModelProvider, override?: boolean): ModelProvider {
  if (override === undefined) return provider; // no-op — today's per-role hardcoded defaults stand
  return {
    async chatOnce(opts: ChatOptions): Promise<ChatResponse> {
      return provider.chatOnce({ ...opts, thinking: override });
    },
  };
}

```

Then find the `resolveLeadProvider` body from Task 5:

```ts
export function resolveLeadProvider(
  settings: Settings,
  ollama: OllamaClient,
  onFallback?: (reason: string) => void,
): ModelProvider {
  if (!settings.hybridMode || !settings.frontier?.apiKey) return localProvider(ollama);
  return withFallback(frontierProviderFor(settings.frontier), localProvider(ollama), onFallback);
}
```

Replace with:

```ts
export function resolveLeadProvider(
  settings: Settings,
  ollama: OllamaClient,
  onFallback?: (reason: string) => void,
): ModelProvider {
  const base = !settings.hybridMode || !settings.frontier?.apiKey
    ? localProvider(ollama)
    : withFallback(frontierProviderFor(settings.frontier), localProvider(ollama), onFallback);
  return withThinkingOverride(base, settings.leadThinking);
}
```

- [ ] **Step 4: Run the full test file to verify everything passes, including the pre-existing tests**

Run: `cd extension && npx vitest run tests/unit/framework_provider.test.ts`
Expected: All tests PASS — **including** the original, unmodified `'resolves to local when hybridMode is off'` test (`expect(p).toBe(fake)`). That test passing unmodified is the actual proof that `leadThinking: undefined` (today's default, via `DEFAULT_SETTINGS` never setting it) is a true no-op end to end: if `withThinkingOverride`'s no-op branch returned a new wrapper object instead of the same reference, that identity check would break. Do not add a separate duplicate test for this — this existing test already covers it once `withThinkingOverride` is wired in.

- [ ] **Step 5: Commit**

```bash
git add extension/src/agent/framework/provider.ts extension/tests/unit/framework_provider.test.ts
git commit -m "feat(framework): add withThinkingOverride, compose into resolveLeadProvider via leadThinking"
```

---

### Task 7: E2E regression test — override plumbing doesn't break the local path

**Files:**
- Modify: `extension/tests/integration/scripted_e2e.test.ts`

- [ ] **Step 1: Write the test**

Add this `it` block inside the existing `describe('scripted-browser E2E ...', ...)` block, after the last existing test (`'sale-price with hybridMode explicitly false matches the pre-tiering baseline'`):

```ts
  it('sale-price with hybridMode false but leadThinking true still completes correctly', async () => {
    const t = task('sale-price');
    const state = new ScriptedBrowser(t);
    const registry = buildScriptedRegistry(state);
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: JSON.stringify({ steps: [{ description: 'open the Studio Wireless Headphones product and report its current price', successCriteria: 'current price reported' }] }) })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'tab.open', args: { url: 'https://shop.example/' } }] }),
        rawResponse({ toolCalls: [{ name: 'tab.click', args: { tabId: 101, elementIndex: 1 } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'The current price is £59.99 (down from £79.99).' } }] }),
      ],
      evaluator: [],
    });
    const orch = new Orchestrator({
      ollama,
      registry,
      settings: { ...DEFAULT_SETTINGS, hybridMode: false, leadThinking: true },
      emit: () => undefined,
    });
    const result = await orch.runUntilTerminal(await orch.start(t.goal));

    expect(result.phase).toBe('DONE');
    expect(result.verdict).toBe('success');

    const run: BenchRun = {
      phase: result.phase, verdict: result.verdict, summary: result.summary,
      observedText: `${t.goal}\n${state.observedText()}`, turns: result.turns, replans: result.replans,
    };
    const score = scoreRun(t.expect, run);
    expect(score, score.reasons.join('; ')).toMatchObject({ completed: true, correct: true, grounded: true });
  });
```

This is deliberately distinct from the existing `hybridMode:false` baseline test right above it — that one proves the *unset* default is unchanged; this one proves the override machinery (`withThinkingOverride` actively forcing `thinking: true` into every call reaching the local fake) doesn't break the real orchestrator's local-only path when a user actually turns it on. No new imports needed — everything used here is already imported in this file.

- [ ] **Step 2: Run the test to verify it fails initially, then passes after Task 6**

If you're running this task after Task 6 is already committed (the expected order), this test should PASS immediately — it's a regression/characterization test for already-implemented behavior, not new production code.

Run: `cd extension && npx vitest run tests/integration/scripted_e2e.test.ts`
Expected: All tests in this file PASS (4 pre-existing + this new one = 5 total).

- [ ] **Step 3: Commit**

```bash
git add extension/tests/integration/scripted_e2e.test.ts
git commit -m "test: leadThinking:true doesn't break the real orchestrator's local-only path"
```

---

### Task 8: Final verification

- [ ] **Step 1: Full suite**

Run: `cd extension && npm run typecheck && npx vitest run && npm run build`
Expected: typecheck clean, all tests pass (0 failures), build succeeds.

- [ ] **Step 2: Bench (if available)**

Run: `cd extension && npm run bench`
Expected: PASS if `ollama serve` is reachable locally. If Ollama isn't reachable in your environment, note that explicitly rather than silently skipping it — do not treat this as a blocking failure.

- [ ] **Step 3: Commit any final cleanup**

Only if Steps 1-2 surfaced something to fix. If everything is already green, there's nothing to commit here — proceed to final review.
