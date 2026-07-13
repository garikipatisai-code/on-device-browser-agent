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
 *  (Anthropic) or reasoning_effort (OpenAI). Local Ollama ignores this field. */
export type ThinkingLevel = 'off' | 'fast' | 'standard' | 'full';

/** Self-contained config for one role group. Brain (planner+evaluator) and
 *  Body (executor+compactor) each get their own. Provider 'ollama' uses the
 *  local Ollama server; frontier providers use the API key + optional base URL. */
export interface RoleGroupConfig {
  provider: Provider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  thinkingLevel?: ThinkingLevel;
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
  /** Ollama context window; default 32768, raise only after verifying VRAM with `ollama ps`. */
  numCtx?: number;
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
    // gemma4:e4b is the floor for this app: measured 100% first-try valid+correct
    // tool_calls at p90 2.1s on M5-class hardware (scripts/measure_toolcalls.mjs).
    // gemma4:e2b is intentionally NOT used — it chose the wrong tool ~60% of the
    // time. Larger tags (gemma4:12b/:26b/:31b) add planning depth but are no more
    // reliable for tool-calling and 12b busts the 6s Executor budget.
    // For a faster body, try gemma4:12b or a frontier model with thinking off.
    brain: { provider: 'ollama', model: 'gemma4:e4b' },
    body:  { provider: 'ollama', model: 'gemma4:e4b' },
  },
  ollamaBaseUrl: 'http://localhost:11434',
  embeddingModel: 'mxbai-embed-large',
  // Multimodal model for vision.read (screenshot → text). Must support images.
  visionModel: 'gemma4:e4b',
  domainTiers: {},
  bypassDomainTiers: false,
  profileJson: '',
  preferences: '',
  numCtx: 32_768,
};

/** Treat a bare model name as equal to its `:latest` tag (Ollama's default). */
export function sameModel(a: string, b: string): boolean {
  const norm = (s: string) => (s.includes(':') ? s : `${s}:latest`);
  return norm(a) === norm(b);
}

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
