// SW ↔ Side Panel message contract.
// All messages serialize through chrome.runtime.connect (long-lived port).

export type TaskPhase =
  | 'IDLE'
  | 'PLANNING'
  | 'EXECUTING'
  | 'EVALUATING'
  | 'COMPACTING'
  | 'BLOCKED'
  | 'ABORTED'
  | 'DONE';

export type Role = 'planner' | 'executor' | 'evaluator' | 'compactor';

export interface Step {
  id: string;
  description: string;
  successCriteria: string;
  toolHint?: string;
  status: 'pending' | 'active' | 'completed' | 'failed';
}

export interface Plan {
  steps: Step[];
  created: number;
}

/** One node in a DAG plan (T6 seam). `needs` names the step ids that must
 *  complete first; `provides` names the var this step publishes for `${var}`
 *  joins in downstream steps. Lean: shape only, no executor wiring yet. */
export interface DagStep {
  id: string;
  description: string;
  successCriteria?: string;
  toolHint?: string;
  needs?: string[];
  provides?: string;
}

export type DomainTier = 'read-only' | 'click-only';

/** A persisted frontier config for the lead seat. 'anthropic' is Claude's own
 *  Messages API; 'openai-compatible' is any backend speaking the OpenAI Chat
 *  Completions shape — OpenAI itself, OpenRouter, DeepSeek, MiniMax, or a
 *  self-hosted server — distinguished only by baseUrl/model, never new code. */
export type FrontierConfig =
  | { provider: 'anthropic'; apiKey: string; model: string }
  | { provider: 'openai-compatible'; apiKey: string; model: string; baseUrl: string };

export type Provider = 'ollama' | 'anthropic' | 'openai-compatible';

/** Normalized thinking budget — maps to provider-native params at call time.
 *  'off' = no extended thinking; 'fast'/'standard'/'full' map to budget_tokens
 *  (Anthropic), reasoning_effort (OpenAI), or think (local Ollama). */
export type ThinkingLevel = 'off' | 'fast' | 'standard' | 'full';

/** Self-contained config for one role group. Brain (planner+evaluator) and
 *  Body (executor+compactor) each get their own. Provider 'ollama' uses the
 *  local Ollama server; frontier providers use the API key + optional base URL.
 *  numCtx is per-role: brain 32K (quality), body 16K (speed). Falls back to
 *  Settings.numCtx (legacy single window) when undefined. */
export interface RoleGroupConfig {
  provider: Provider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  thinkingLevel?: ThinkingLevel;
  numCtx?: number;
}

/** Brain/Body model assignment. Replaces the 14 scattered model/frontier/
 *  thinking/hybrid fields with two self-contained role-group configs. */
export interface AgentConfig {
  brain: RoleGroupConfig;
  body: RoleGroupConfig;
}

export interface Settings {
  /** Schema version for migration. undefined = v0 (scattered fields), 1 = AgentConfig. */
  schemaVersion?: number;
  /** Brain (planner+evaluator) and Body (executor+compactor) model config.
   *  Always present after migration from v0. */
  agent?: AgentConfig;
  ollamaBaseUrl: string;
  // ---- deprecated below (v0 fields, kept for migration — read agent.* instead) ----
  /** @deprecated Use agent.brain.model instead. */
  plannerModel?: string;
  /** @deprecated Use agent.body.model instead. */
  executorModel?: string;
  /** @deprecated Use agent.brain.model instead. */
  evaluatorModel?: string;
  /** @deprecated Use agent.body.model instead. */
  compactorModel?: string;
  embeddingModel: string;
  /** Multimodal model for vision.read (screenshot → text). Must support images.
   *  Not part of the brain/body split — vision tools use this directly. */
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
  /** Legacy single Ollama context window; per-role agent.brain/body.numCtx take
   *  precedence when set. Kept as fallback for pre-split installs. Default 32768,
   *  raise only after verifying VRAM with `ollama ps`. */
  numCtx?: number;
  /** Opt-in: constrain executor tool-call responses with Ollama structured outputs
   *  (JSON-Schema grammar decoding on the local provider). Off by default — request bodies
   *  stay byte-identical unless enabled. Only affects the local Ollama path; frontier
   *  providers ignore it (they have their own native tool-calling formats). */
  structuredToolCalls?: boolean;
  /** Opt-in: dispatch independent DAG steps (`needs`/`provides`) in parallel waves
   *  via dispatchDagPlan instead of legacy sequential order. Off by default —
   *  the off path is byte-identical sequential; cyclic/invalid graphs fail
   *  closed to sequential even when on. */
  dagDispatch?: boolean;
  /** Opt-in: anchor FACTS+ANCHOR through compaction and enforce the strict
   *  numbers+entities finish gate (T20). Off by default — the off path is
   *  byte-identical legacy (scratch tail slice + passthrough finish, no strict
   *  gate). On threads resolveAnchoredCompaction + resolveFinishGate. Zero
   *  production call-sites as of T20 — wiring deferred to scheduler. */
  anchoredGate?: boolean;
  /** Opt-in: constrict the agent for constrained hardware (small context window, low RAM/VRAM,
   *  one slow local model). Off by default — every downstream constriction is a no-op passthrough
   *  when false, so behavior is byte-identical to the baseline unless explicitly enabled. */
  limitedResources?: boolean;
  // ---- v0 frontier/thinking fields (kept for migration) ----
  /** @deprecated Use agent.brain.provider instead. */
  hybridMode?: boolean;
  /** @deprecated Use agent.brain.apiKey + agent.brain.model instead. */
  frontier?: FrontierConfig;
  /** @deprecated Use agent.brain.thinkingLevel instead. */
  leadThinking?: boolean;
  /** @deprecated Use agent.brain.thinkingLevel instead. */
  leadThinkingEffort?: 'low' | 'medium' | 'high';
  /** @deprecated Use agent.body.provider instead. */
  hybridHelpers?: boolean;
  /** @deprecated Use agent.body.apiKey + agent.body.model instead. */
  helperFrontier?: FrontierConfig;
  /** @deprecated Use agent.body.thinkingLevel instead. */
  helperThinking?: boolean;
  /** @deprecated Use agent.body.thinkingLevel instead. */
  helperThinkingEffort?: 'low' | 'medium' | 'high';
}

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1,
  agent: {
    // PC hybrid brain/body split: brain gemma4:e4b for quality, body gemma4:e2b for speed.
    // Per-role windows: brain 32K (quality), body 16K (speed + VRAM). Speed comes from
    // smaller weights (e2b 4.6GB vs e4b 6.6GB) AND the smaller body window.
    brain: { provider: 'ollama', model: 'gemma4:e4b-it-q4_K_M', thinkingLevel: 'standard', numCtx: 32_768 },
    body:  { provider: 'ollama', model: 'gemma4:e2b-it-q4_K_M', thinkingLevel: 'off', numCtx: 16_384 },
  },
  ollamaBaseUrl: 'http://localhost:11434',
  embeddingModel: 'mxbai-embed-large',
  // Multimodal model for vision.read (screenshot → text). Must support images.
  visionModel: 'gemma4:e4b-it-q4_K_M',
  domainTiers: {},
  bypassDomainTiers: false,
  profileJson: '',
  preferences: '',
  // Legacy single-window fallback (budget.ts DEFAULT_NUM_CTX). Per-role
  // agent.brain/body.numCtx take precedence; the orchestrator clamps each.
  // Raise only after verifying VRAM with `ollama ps`.
  numCtx: 32_768,
  structuredToolCalls: false,
  limitedResources: false,
  anchoredGate: false,
  dagDispatch: false,
};

/** Treat a bare model name as equal to its `:latest` tag (Ollama's default).
 *  Also equates quantization-suffixed variants of the same size
 *  (gemma4:e4b == gemma4:e4b-it-q4_K_M == gemma4:e4b-it-q8_0) so stale
 *  bare-tag fallbacks still match the installed q4 pull. Size stays distinct:
 *  e4b variants never equal e2b variants (different weights). */
export function sameModel(a: string, b: string): boolean {
  const norm = (s: string) => {
    const withTag = s.includes(':') ? s : `${s}:latest`;
    const [name, tag = ''] = withTag.split(':');
    // Strip the quant/IT suffix: e4b-it-q4_K_M → e4b, e2b-it-q4_K_M → e2b.
    // A bare size tag (e4b) already equals the stripped form.
    const base = tag.split('-')[0];
    return `${name}:${base}`;
  };
  return norm(a) === norm(b);
}

/** Settings-ingest guard for the Ollama base URL.
 *  Allowlist: http/https on loopback only (localhost or 127.0.0.1).
 *  Rejects userinfo, private/RFC1918/link-local addresses, and any
 *  non-loopback host — SSRF against the local machine is the key risk,
 *  so this fails closed at settings-ingest time and again in setBaseUrl.
 */
export function assertAllowedOllamaBaseUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid Ollama base URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Ollama base URL must use http or https: ${url}`);
  }
  if (parsed.username !== '') {
    throw new Error(`Ollama base URL must not contain userinfo: ${url}`);
  }
  if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new Error(`Ollama base URL must point at loopback (localhost/127.0.0.1): ${url}`);
  }
}

/** Canonical GBNF grammar-constrained tool-call schema (Ollama structured outputs).
 *  `additionalProperties: false` is the teeth: the grammar rejects any key
 *  outside {tool, args}, so a small model cannot smuggle free-form prose
 *  alongside the tool call. Keep in sync with the executor's local copy. */
export const TOOL_CALL_GBNF_SCHEMA = {
  type: 'object',
  properties: {
    tool: { type: 'string', description: 'Exact tool name from the provided tool catalog' },
    args: { type: 'object', description: "The tool's arguments object" },
  },
  required: ['tool'],
  additionalProperties: false,
} as const;

// ---- timeline events shown to the user ----

export type TimelineEvent =
  | { kind: 'planner.plan'; ts: number; plan: Plan }
  | { kind: 'role.start'; ts: number; role: Role; stepId?: string }
  | { kind: 'role.end'; ts: number; role: Role; ms: number }
  | { kind: 'tool.call'; ts: number; tool: string; args: unknown }
  | { kind: 'tool.result'; ts: number; tool: string; ok: boolean; content: string }
  | { kind: 'evaluator.verdict'; ts: number; verdict: 'PASS' | 'FAIL'; reason: string }
  | { kind: 'breaker.trip'; ts: number; reason: string }
  | { kind: 'antibot.blocked'; ts: number; label: string }
  | { kind: 'antibot.resolved'; ts: number }
  | { kind: 'compaction'; ts: number; before: number; after: number }
  | { kind: 'log'; ts: number; level: 'info' | 'warn' | 'error'; message: string }
  | { kind: 'finish'; ts: number; verdict: string; summary: string; sources?: string[] };

// ---- panel → SW commands ----

export type PanelCommand =
  | { type: 'agent.start'; goal: string }
  | { type: 'agent.askPage'; question: string }
  | { type: 'agent.steer'; text: string }
  | { type: 'agent.abort' }
  | { type: 'agent.status' }
  | { type: 'settings.get' }
  | { type: 'settings.set'; settings: Partial<Settings> }
  | { type: 'domainTier.set'; host: string; tier: DomainTier }
  | { type: 'profile.extract'; resumeText: string }
  | { type: 'resume.store'; name: string; mime: string; base64: string }
  | { type: 'recipes.clear' }
  | { type: 'recipes.list' }
  | { type: 'recipes.save'; input: UserRecipeDraft }
  | { type: 'recipes.delete'; id: string }
  | { type: 'models.list' }
  | { type: 'preflight' }
  | { type: 'session.new' }
  | { type: 'session.list' }
  | { type: 'session.select'; sessionId: string }
  | { type: 'session.delete'; sessionId: string }
  | { type: 'session.turnEvents'; taskId: string };

/** One turn's identity + outcome inside a session's transcript. `verdict`/`summary` are
 *  undefined until the turn reaches a terminal state (set by updateSessionTurnResult). */
export interface SessionTurn {
  taskId: string;
  goal: string;
  verdict?: string;
  summary?: string;
}

/** A chat-style session: an ordered list of turns (each turn is one Orchestrator run,
 *  its own taskId) sharing carried-forward context (facts + last summary). */
export interface Session {
  id: string;
  title: string;
  createdAt: number;
  lastActiveAt: number;
  turns: SessionTurn[];
}

/** A recipe as shown/edited in the Recipes tab (UI mirror of the agent's Workflow). */
export interface RecipeView {
  id: string;
  origin: 'builtin' | 'user' | 'auto';
  name: string;
  whenToUse: string;
  site: string;
  steps: Array<{ instruction: string; toolHint?: string }>;
  trusted?: boolean;
  /** Rendered exactly as the planner receives it (the live preview). */
  preview: string;
}

/** What the guided editor submits (id present = edit; absent = new). */
export interface UserRecipeDraft {
  id?: string;
  name: string;
  whenToUse: string;
  site?: string;
  stepsText: string;
}

// ---- SW → panel updates ----

export interface AgentStatus {
  phase: TaskPhase;
  goal: string | null;
  plan: Plan | null;
  currentStepId: string | null;
  replanCount: number;
  ownedTabs: number[];
}

export type SwUpdate =
  | { type: 'status'; status: AgentStatus }
  | { type: 'timeline'; events: TimelineEvent[] }
  | { type: 'append'; event: TimelineEvent }
  | { type: 'settings'; settings: Settings }
  | { type: 'preflight'; ok: boolean; details: Record<string, unknown> }
  | { type: 'models'; ok: boolean; models: string[]; error?: string }
  | { type: 'profileExtracted'; ok: boolean; profileJson?: string; error?: string }
  | { type: 'resumeStored'; ok: boolean; name?: string; error?: string }
  | { type: 'recipes'; recipes: RecipeView[] }
  | { type: 'metrics'; metrics: MetricsSnapshot }
  | { type: 'error'; message: string }
  | { type: 'sessions'; sessions: Session[]; activeSessionId: string | null }
  | { type: 'turnEvents'; taskId: string; events: TimelineEvent[] };

export interface MetricsSnapshot {
  ops: Array<{
    op: string;
    n: number;
    ok: number;
    p50: number;
    mean: number;
  }>;
}

export const PORT_NAME = 'browser-agent';

// ---- T9 flat MCP catalog + parent_child contract (BRAIN-only, pure) ----

/** One flattened tool entry for a small-model-safe MCP catalog: parameters
 *  contain no nested `anyOf` (unions collapse to `string` at flatten time).
 *  `parent` groups child tools under one retrieval anchor (e.g. page.*). */
export interface FlatToolEntry {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  parent?: string;
}

/** Parent ↔ child link for parent_child retrieval (index chunks, return parents). */
export interface ParentChildLink {
  parent: string;
  child: string;
}
