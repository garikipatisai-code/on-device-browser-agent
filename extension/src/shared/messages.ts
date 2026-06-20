// SW ↔ Side Panel message contract.
// All messages serialize through chrome.runtime.connect (long-lived port).

export type TaskPhase =
  | 'IDLE'
  | 'PLANNING'
  | 'EXECUTING'
  | 'EVALUATING'
  | 'COMPACTING'
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

export type DomainTier = 'read-only' | 'click-only' | 'full-action';

export interface Settings {
  ollamaBaseUrl: string;
  plannerModel: string;
  executorModel: string;
  evaluatorModel: string;
  compactorModel: string;
  embeddingModel: string;
  visionModel: string;
  domainTiers: Record<string, DomainTier>;
  /** JSON object of the user's data (name, email, etc.) used to fill application
   *  forms. Injected into the Executor context; never invented by the model. */
  profileJson?: string;
  cloud?: {
    provider?: 'deepseek' | 'anthropic';
    apiKey?: string;
    enabledRoles?: Role[];
  };
}

export const DEFAULT_SETTINGS: Settings = {
  ollamaBaseUrl: 'http://localhost:11434',
  // gemma4:e4b is the floor for this app: measured 100% first-try valid+correct
  // tool_calls at p90 2.1s on M5-class hardware (scripts/measure_toolcalls.mjs).
  // gemma4:e2b is intentionally NOT used — it chose the wrong tool ~60% of the
  // time. Larger tags (gemma4:12b/:26b/:31b) add planning depth but are no more
  // reliable for tool-calling and 12b busts the 6s Executor budget.
  plannerModel: 'gemma4:e4b',
  executorModel: 'gemma4:e4b',
  evaluatorModel: 'gemma4:e4b',
  compactorModel: 'gemma4:e4b',
  embeddingModel: 'mxbai-embed-large',
  // Multimodal model for vision.read (screenshot → text). Must support images.
  visionModel: 'gemma4:e4b',
  domainTiers: {},
  profileJson: '',
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
  | { kind: 'compaction'; ts: number; before: number; after: number }
  | { kind: 'log'; ts: number; level: 'info' | 'warn' | 'error'; message: string }
  | { kind: 'finish'; ts: number; verdict: string; summary: string };

// ---- panel → SW commands ----

export type PanelCommand =
  | { type: 'agent.start'; goal: string }
  | { type: 'agent.abort' }
  | { type: 'agent.status' }
  | { type: 'settings.get' }
  | { type: 'settings.set'; settings: Partial<Settings> }
  | { type: 'domainTier.set'; host: string; tier: DomainTier }
  | { type: 'profile.extract'; resumeText: string }
  | { type: 'resume.store'; name: string; mime: string; base64: string }
  | { type: 'models.list' }
  | { type: 'preflight' };

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
  | { type: 'metrics'; metrics: MetricsSnapshot }
  | { type: 'error'; message: string };

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
