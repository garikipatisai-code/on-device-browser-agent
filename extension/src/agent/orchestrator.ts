// Orchestrator: state machine ties everything together.
// IDLE → PLANNING → EXECUTING → EVALUATING → EXECUTING (next step) → ... → DONE | ABORTED.

import type { OllamaClient } from '@/background/ollama';
import type { Plan, Settings, Step, DagStep, TimelineEvent } from '@/shared/messages';
import { TOOL_CALL_GBNF_SCHEMA } from '@/shared/messages';
import {
  type AgentStateHot,
  _setHot,
  addFinding,
  appendEvent,
  appendTurnToSession,
  clearHot,
  getScratchpad,
  loadHot,
  loadSessionContext,
  patchHot,
  saveSessionContext,
  setScratchpad,
  touchHot,
  updateSessionTurnResult,
} from '@/background/state_store';
import type { ToolRegistry } from './tools/registry';
import type { ToolContext, ToolResult } from './tools/registry';
import type { ExecutorOutput } from './roles/executor';
import type { Verdict } from './roles/evaluator';
import { addGroundedFact, renderFacts, type Fact } from './facts';
import { runHeadChef } from './framework/head_chef';
import { runSousChef, verifyFinish, gateFinishSummary } from './framework/sous_chef';
import { runHelper, runHelperCompaction } from './framework/helper';
import { resolveProvider, withThinkingOverride, type ModelProvider } from './framework/provider';
import { actionHash, TokenRatioEstimator, ulid } from './util';
import { checkBudget, clampNumCtx, NUM_CTX, capsFor, PROBE_THINK_SKIP_CONFIDENCE, PROBE_TOOL_SKIP_CONFIDENCE } from './budget';
import {
  type BreakerState,
  checkBreaker,
  newBreakerState,
  recordAction,
  resetForNewStep,
} from './safety/circuit_breaker';
import { currentStep, newPlan, walkPlan } from './plan';
import { buildPlannerMessages, wrapPageContent } from './prompts';
import { timed } from './metrics';
import { redact, redactDeep, redactEvent } from './safety/redact';
import { mentionsMissing } from './verify/grounding';
import { findConsentDismiss } from './tools/browser/consent';
import { detectAntiBotBlock } from './tools/browser/antibot';
import { getDomainTier, hostFor, isBlockedUrl, TIER_ORDER } from './safety/domain_tiers';
import { sleep } from '@/background/signal';
import { waitForTabSettled } from './tools/browser/tab';
import { clearSearchResults } from './tools/browser/search';
import { matchWorkflow, renderRecipe, loadWorkflows, saveWorkflow, traceToWorkflow, traceHasRedundancy, traceWorthLearning, markWorkflowTrusted, quarantineWorkflow, deriveDomain, lookupRecovery, type Workflow } from './workflow_memory';
import { renderProfileBlock } from './profile';

// Tools whose output IS page content. The orchestrator carries the most recent
// such result forward into every executor turn (as CURRENT PAGE CONTENT) so that
// synthesis/report turns can actually see the data — the scratchpad only keeps an
// 800-char tail, far too little to list products/prices from.
const READING_TOOLS = new Set(['aria.extract', 'vision.read', 'search', 'tab.read_active']);

// Observation tools (read the page). The executor may not call the SAME one twice
// in a row within a step — it was looping aria.extract instead of acting. Allowing
// the OTHER one preserves the aria→vision fallback.
const OBSERVATION_TOOLS = new Set(['aria.extract', 'vision.read']);

// Actions that (almost) always change the page → the harness auto-re-extracts the
// new page afterward (a small model often fails to re-read and re-uses stale element
// indices, or produces no tool call when forced). tab.type counts only when it submits.
const NAVIGATING_TOOLS = new Set(['tab.click', 'open_result', 'tab.open']);

/** Think-routing: single-tool tasks run NO_THINK (fast, low VRAM); multi-turn
 *  tasks and every-3rd turn run THINK (re Grounding before the next act). */
export type ThinkRoute = 'NO_THINK' | 'THINK';

/** Executor self-correction is bounded to a single nudge retry (first + 1). */
export const EXECUTOR_RETRY_MAX = 1;

/** True while another executor attempt is allowed (attempts so far < max). */
export function shouldRetryExecutor(attemptsSoFar: number): boolean {
  return attemptsSoFar < EXECUTOR_RETRY_MAX;
}

/** Quick-chat FAST_PATH helper — single source is background/quick_chat
 *  (isTrivialChitchat); re-exported here under the orchestrator's name so
 *  tests/callers have one seam. Helpers-only seam: stageGate/fast-path are
 *  NOT yet wired into evaluate/index — wiring needs a bench run, deferred. */
export { isTrivialChitchat as isQuickChat } from '@/background/quick_chat';

/** Loop-guard escalation stages. Bounded: retry → reformat → switch → terminate,
 *  then sticks at terminate (no extra action past it). */
export type LoopGuardAction = 'retry' | 'reformat' | 'switch' | 'terminate';

export class LoopGuard {
  private failures = 0;

  /** Evaluator stage-gate: only a PASS verdict advances the plan. */
  stageGate(verdict: 'PASS' | 'FAIL'): boolean {
    return verdict === 'PASS';
  }

  /** Record one failure; returns the bounded next action (<1 extra past terminate). */
  recordFailure(): LoopGuardAction {
    this.failures += 1;
    if (this.failures <= 1) return 'retry';
    if (this.failures <= 2) return 'reformat';
    if (this.failures <= 3) return 'switch';
    return 'terminate';
  }

  get failureCount(): number {
    return this.failures;
  }
}

/** Route think on/off: every-3rd turn always re-thinks; multi-step plans think;
 *  otherwise (single-tool, non-3rd turn) skip thinking. `turn` is 1-based. */
export function routeThink(opts: { stepCount: number; turn: number }): ThinkRoute {
  if (opts.turn > 0 && opts.turn % 3 === 0) return 'THINK';
  if (opts.stepCount > 1) return 'THINK';
  return 'NO_THINK';
}

/** T7 probe-gated think routing (BRAIN-only, pure): layers a cheap confidence
 *  probe over routeThink. A high-confidence probe (page/workspace already holds
 *  the answer) downgrades a base THINK to NO_THINK; a base NO_THINK stays
 *  NO_THINK. `probeConfidence` is 0..1 (missing/NaN counts as 0 = no skip).
 *  T6 debt (deferred to scheduler, NOT this seam): DAG semantic validation
 *  (cyclic `needs`, over-deep `${var}` chains) + dispatch fallback
 *  idempotence (sequential retry may re-run a side-effecting wave step). */
export function routeThinkProbe(opts: { stepCount: number; turn: number; probeConfidence?: number }): ThinkRoute {
  const base = routeThink({ stepCount: opts.stepCount, turn: opts.turn });
  if (base === 'NO_THINK') return 'NO_THINK';
  const conf = typeof opts.probeConfidence === 'number' && Number.isFinite(opts.probeConfidence) ? opts.probeConfidence : 0;
  if (conf >= PROBE_THINK_SKIP_CONFIDENCE) return 'NO_THINK';
  return 'THINK';
}

/** T7 probe-gated tool skip (BRAIN-only, pure): true ONLY for a redundant
 *  observe tool (`aria.extract`/`vision.read`) with probe confidence at/above
 *  PROBE_TOOL_SKIP_CONFIDENCE. Never true for navigating/acting tools
 *  (`tab.click`, `tab.open`, `open_result`, `tab.type`, …) or any non-observe
 *  tool — a skipped act could strand the run; a skipped re-read only drops a
 *  duplicate. `redundant` must be explicitly true (fail-closed). */
export function shouldSkipTool(opts: { tool: string; probeConfidence?: number; redundant: boolean }): boolean {
  if (!opts.redundant) return false;
  if (!OBSERVATION_TOOLS.has(opts.tool)) return false;
  const conf = typeof opts.probeConfidence === 'number' && Number.isFinite(opts.probeConfidence) ? opts.probeConfidence : 0;
  return conf >= PROBE_TOOL_SKIP_CONFIDENCE;
}

/** T10 anchored compact input (BRAIN-only, pure, 0 LLM calls). */
export interface AnchoredCompactInput {
  goal: string;
  facts: string;
  anchor: string;
  scratch: string;
  maxChars: number;
}

/** T10 anchored compact (BRAIN-only, pure): header preserves goal+facts+anchor,
 *  then fills with the scratch PREFIX (head, not tail) up to maxChars.
 *  FACTS and ANCHOR are never truncated — goal is truncated first to fit, then
 *  scratch; if the mandatory facts+anchor alone exceed the budget the full
 *  header is returned intact (over budget) rather than cutting them.
 *  NOTE: zero production call-sites as of T10 — intentional stub; wiring deferred to scheduler. */
export function anchoredCompact(input: AnchoredCompactInput): string {
  const goal = input.goal ?? '';
  const facts = input.facts ?? '';
  const anchor = input.anchor ?? '';
  const scratch = input.scratch ?? '';
  const maxChars = Number.isFinite(input.maxChars) && input.maxChars > 0 ? Math.floor(input.maxChars) : 0;
  if (maxChars <= 0) return '';
  const fixed = `FACTS: ${facts}\nANCHOR: ${anchor}\n`;
  const goalPrefix = 'GOAL: ';
  const goalSuffix = '\n';
  if (fixed.length + goalPrefix.length + goalSuffix.length >= maxChars) {
    return `GOAL: ${goal}\n${fixed}`;
  }
  const goalRoom = maxChars - fixed.length - goalPrefix.length - goalSuffix.length;
  const header = `${goalPrefix}${goal.slice(0, goalRoom)}${goalSuffix}${fixed}`;
  const room = maxChars - header.length;
  return header + scratch.slice(0, room);
}

/** Structured-output format for the executor path. Returns the GBNF schema
 *  (additionalProperties:false) when enabled, else undefined (byte-identical
 *  default path). The executor consumes the boolean; this helper is the seam
 *  that pins the exact schema the flag implies. */
export function structuredToolCallFormat(structured: boolean): typeof TOOL_CALL_GBNF_SCHEMA | undefined {
  return structured ? TOOL_CALL_GBNF_SCHEMA : undefined;
}

/** T6 DAG seam: parse a raw plan into validated DagSteps, fail-closed (`[]`
 *  on any invalid shape). Pure + deterministic: input order preserved. */
export function parseDagPlan(raw: unknown): DagStep[] {
  if (!raw || typeof raw !== 'object') return [];
  const steps = (raw as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return [];
  const out: DagStep[] = [];
  for (const s of steps) {
    if (!s || typeof s !== 'object') return [];
    const r = s as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id || typeof r.description !== 'string' || !r.description) return [];
    const step: DagStep = { id: r.id, description: r.description };
    if (typeof r.successCriteria === 'string') step.successCriteria = r.successCriteria;
    if (typeof r.toolHint === 'string') step.toolHint = r.toolHint;
    if (r.needs !== undefined) {
      if (!Array.isArray(r.needs) || r.needs.some((n) => typeof n !== 'string')) return [];
      step.needs = [...(r.needs as string[])];
    }
    if (r.provides !== undefined) {
      if (typeof r.provides !== 'string' || !r.provides) return [];
      step.provides = r.provides;
    }
    out.push(step);
  }
  return out;
}

/** Substitute `${var}` refs from `vars`; unknown vars become `''`.
 *  Pure + deterministic (single left-to-right pass). */
export function joinVarRefs(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{([^}]+)\}/g, (_m, name: string) => vars[name] ?? '');
}

/** Fan one wave of independent steps out in parallel — `Promise.all` keeps
 *  results in input order (deterministic). On any failure, fall back to a
 *  sequential in-order retry. The runner is injected (0 LLM calls in test);
 *  production passes a `runHelper`-backed runner. */
export async function dispatchDagWave<T>(
  steps: DagStep[],
  run: (step: DagStep) => Promise<T>,
): Promise<T[]> {
  try {
    return await Promise.all(steps.map((s) => run(s)));
  } catch {
    const out: T[] = [];
    for (const s of steps) out.push(await run(s));
    return out;
  }
}

/** The exact shape the executor role returns (tool, args, result, eval counts). */
type ExecutorOut = ExecutorOutput;

export interface OrchestratorOpts {
  ollama: OllamaClient;
  registry: ToolRegistry;
  settings: Settings;
  emit: (event: TimelineEvent) => void;
  signal?: AbortSignal;
  maxReplans?: number;
  maxStepTurns?: number;
  /** A pre-built plan that bypasses the planner LLM call (fast path, e.g. "Ask this page"). */
  seedPlan?: Array<{ description: string; successCriteria: string; toolHint?: string }>;
  /** How often to re-check for an anti-bot block clearing while paused. Default 5000ms in
   *  production; tests override this to keep the polling loop fast. */
  antiBotPollMs?: number;
}

export interface RunResult {
  phase: 'DONE' | 'ABORTED';
  summary: string;
  verdict: string;
  turns: number;
  replans: number;
}

export class Orchestrator {
  private signal: AbortSignal;
  private est = new TokenRatioEstimator();
  private breaker: BreakerState = newBreakerState();
  private recentActions: Array<{ tool: string; args: unknown; ok: boolean; content: string; ts: number }> = [];
  private taskId = ulid();
  // Per-role windows: brain 32K (quality) vs body 16K (speed). Initialized in
  // start() from agent.brain/body.numCtx (fallback: legacy settings.numCtx).
  private brainNumCtx = NUM_CTX;
  private bodyNumCtx = NUM_CTX;
  private brainCaps = capsFor(NUM_CTX);
  private bodyCaps = capsFor(NUM_CTX);
  // Full content of the most recent page read (aria.extract / vision.read / search).
  // Re-injected into every executor turn so synthesis/report steps can see the data.
  private lastRead: { tool: string; url?: string; content: string } | null = null;
  // Everything read this task (capped) — the corpus the finish-verifier grounds against.
  private observedText = '';
  private facts: Fact[] = [];
  /** Cached workspace entries so commonCtx can inject them synchronously. */
  private workspaceCache: Array<{ title: string; content: string; url?: string }> = [];
  /** Reload workspace cache from storage — catches entries added by the workspace.add tool
   *  (which writes directly to chrome.storage, bypassing this cache). Called before every
   *  verification to ensure the grounding corpus is complete. */
  private async syncWorkspaceCache(): Promise<void> {
    try {
      const { ['agent.workspace']: raw } = await chrome.storage.local.get('agent.workspace');
      if (Array.isArray(raw)) this.workspaceCache = raw as Array<{ title: string; content: string; url?: string }>;
    } catch { /* non-critical */ }
  }
  /** Grounding corpus = observedText + workspace content (workspace doesn't rotate out). */
  private groundingCorpus(): string {
    const ws = this.workspaceCache.map((e) => `${e.title} ${e.content}`).join('\n');
    return ws ? `${this.observedText}\n${ws}` : this.observedText;
  }
  private sessionId: string | null = null;
  private priorSummary = '';
  /** Set by plan() when the planner signals GOAL isn't actionable — checked once by
   *  runUntilTerminal right after planning, before entering the execute/evaluate loop. */
  private plannerNoGoal = false;
  // How many times a success finish failed verification this task (bounds self-correction).
  private verifyAttempts = 0;
  // Real executor-turn count this task (for RunResult.turns; recentActions is capped at 5).
  private turns = 0;
  // Consecutive fatal tool results — a hard block (e.g. tier denial) ends the run promptly.
  private consecutiveFatal = 0;
  // Sticky (per-run) flag: the agent hit an action/tier denial at some point. Used to decide
  // whether a later non-success exit should be SALVAGED from observedText — a give-up that
  // follows a denial usually means the facts were already read (e.g. search snippets) and the
  // model just fumbled the last mile, vs an honest "not found" (no denial → keep that verdict).
  private sawActionDenial = false;
  // Observe-then-act gate: the observation tool used on the previous turn (blocked
  // on the next turn) and the step it applies to (reset when the step changes).
  private lastObserveTool: string | null = null;
  private observeGateStep: string | null = null;
  // Workflow memory: a proven recipe matched to the goal, injected into the planner.
  private matchedWorkflow: Workflow | null = null;
  // Evaluator-driven backtracking: distinct prior page states (url-differentiated), newest
  // last, capped. On a FAIL that would burn a full replan, the most recent DISTINCT earlier
  // page can be restored so the executor retries from a known-good position instead.
  private pageHistory: Array<{ tool: string; url?: string; content: string }> = [];
  private backtracksUsed = 0;
  // The tool sequence executed this run — generalized into a recipe on success (Phase 2).
  private trace: Array<{ tool: string; args: Record<string, unknown> }> = [];
  // Distinct page URLs read this run — surfaced as citations on the finish.
  private sourceUrls = new Set<string>();
  // Mid-run user corrections ("steer"): surfaced as high-priority guidance to the planner/executor
  // on the next turn, so the user can redirect a live task without aborting it.
  private steerNotes: string[] = [];
  // A run is "clean" only if it had NO friction (no replan, evaluator FAIL, tier/fatal denial,
  // breaker trip, or finish rejection). We auto-record a recipe ONLY from a clean run, so a messy
  // success (e.g. combined-query → list page → denial → recover) can't poison the recipe store.
  private runDirty = false;
  private dirtyReason = '';
  private leadProvider: ModelProvider;
  private helperProvider: ModelProvider;

  constructor(private opts: OrchestratorOpts) {
    this.signal = opts.signal ?? new AbortController().signal;
    const agent = opts.settings.agent!;
    this.leadProvider = resolveProvider(agent.brain, opts.ollama, (reason) =>
      this.emit({
        kind: 'log',
        ts: Date.now(),
        level: 'warn',
        message: `Brain frontier call failed, using local: ${reason}`,
      }),
    );
    this.helperProvider = resolveProvider(agent.body, opts.ollama, (reason) =>
      this.emit({
        kind: 'log',
        ts: Date.now(),
        level: 'warn',
        message: `Body frontier call failed, using local: ${reason}`,
      }),
    );
  }

  async start(goal: string, sessionId?: string | null): Promise<AgentStateHot> {
    const trimmed = goal.trim();
    if (!trimmed) throw new Error('goal is empty');
    this.est.reset();
    this.breaker = newBreakerState();
    this.recentActions = [];
    this.lastRead = null;
    this.pageHistory = [];
    this.backtracksUsed = 0;
    this.observedText = '';
    this.verifyAttempts = 0;
    this.turns = 0;
    this.consecutiveFatal = 0;
    this.sawActionDenial = false;
    this.lastObserveTool = null;
    this.observeGateStep = null;
    clearSearchResults(); // don't let a prior task's results ground/block this one
    this.trace = [];
    this.sourceUrls = new Set();
    this.steerNotes = [];
    this.runDirty = false;
    this.plannerNoGoal = false;
    this.dirtyReason = '';
    this.matchedWorkflow = matchWorkflow(trimmed, await loadWorkflows());
    this.workspaceCache = [];
    try { await chrome.storage.local.remove('agent.workspace'); } catch { /* non-critical */ }
    this.taskId = ulid();
    const agentCfg = this.opts.settings.agent;
    this.brainNumCtx = clampNumCtx(agentCfg?.brain.numCtx ?? this.opts.settings.numCtx);
    this.bodyNumCtx = clampNumCtx(agentCfg?.body.numCtx ?? this.opts.settings.numCtx);
    this.brainCaps = capsFor(this.brainNumCtx);
    this.bodyCaps = capsFor(this.bodyNumCtx);
    this.sessionId = sessionId ?? null;
    if (this.sessionId) {
      const carried = await loadSessionContext(this.sessionId);
      this.facts = carried.facts;
      this.priorSummary = carried.lastSummary;
      // Recorded at start (not after finishOk/abortNow) so a future UI can show an in-progress turn;
      // this means turns can include one that never reaches a terminal state (e.g. an unhandled
      // crash), left with no verdict/summary — sessionContext's own facts/summary only reflect
      // turns that actually finished.
      await appendTurnToSession(this.sessionId, this.taskId, trimmed);
    } else {
      this.facts = [];
      this.priorSummary = '';
    }
    const hot = await _setHot(trimmed);
    await setScratchpad(this.taskId, '');
    this.log('info', `Task started: ${trimmed}`);
    if (this.matchedWorkflow) this.log('info', `Workflow recipe matched: ${this.matchedWorkflow.id}`);
    return hot;
  }

  /** Inject a mid-run user correction ("steer"). Surfaced as high-priority guidance on the next
   *  planner/executor turn — the user redirecting a live task without aborting it. Best-effort:
   *  blank input is ignored; bounded to the last few so guidance can't grow unbounded.
   *  T8 DEBT (deferred to scheduler, NOT fixed here): the cap-5 FIFO eviction drops the
   *  oldest steer note without priority — a scheduler-owned queue should rank/persist them. */
  steer(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.steerNotes.push(t);
    if (this.steerNotes.length > 5) this.steerNotes.shift();
    this.emit({ kind: 'log', ts: Date.now(), level: 'info', message: `Steering (takes effect next turn): ${t}` });
  }

  async runUntilTerminal(initial: AgentStateHot): Promise<RunResult> {
    let hot = initial;
    let turn = 0;
    const maxTurns = (this.opts.maxStepTurns ?? 8) * 12;

    // Fast path: a seeded plan (e.g. "Ask this page") skips the planner entirely — the slowest
    // call (up to 300s) — for goals where the steps are already known.
    hot =
      this.opts.seedPlan && this.opts.seedPlan.length
        ? await this.seedPlanInto(hot, this.opts.seedPlan)
        : await this.plan(hot);

    // The planner determined GOAL isn't actionable — finish immediately rather than dispatching a
    // fake step to the Executor (which has no tool that can satisfy "please provide a goal" and
    // would just loop). Never true on the seedPlan path (askPage always has a real forced step).
    if (this.plannerNoGoal) {
      return this.finishOk(hot, 'blocked', 'I need a clearer goal to work with — could you tell me what you\'d like me to do?');
    }

    while (turn < maxTurns) {
      this.assertNotAborted();
      await touchHot();
      const step = currentStep(hot.plan);
      if (!step) {
        return this.finishOk(hot, 'success', 'Plan complete — no remaining steps.');
      }

      const execOut = await this.executeOne(hot, step.id);
      turn += 1;
      this.turns = turn;
      hot = await this.refreshHot(hot);

      // Sync workspace cache before verification — the workspace.add tool writes directly
      // to chrome.storage and bypasses the orchestrator's cache. Without this sync, any
      // workspace entry added by the tool during the executor turn is invisible to the
      // grounding verifier and causes false rejections.
      await this.syncWorkspaceCache();

      if (execOut.result.finish) {
        const fin = execOut.result.finish;
        // Honest failures (blocked/failed) aren't fabrication risks. A 'partial' carries data,
        // so route it through the grounding gate too (flags an ungrounded number, no retry).
        if (fin.verdict !== 'success') {
          // But the model may be conceding defeat while observedText ALREADY holds the answer (it
          // hit a read-only/tier denial after the facts were read). Prefer a grounded salvage over
          // the defeatist message; preferSalvageOnDenial no-ops (keeps this verdict) if no denial
          // occurred — so a genuine "not found" stays an honest blocked/failed.
          return this.preferSalvageOnDenial(hot, gateFinishSummary(fin.verdict, fin.summary, this.groundingCorpus(), this.facts));
        }
        const v = verifyFinish(fin.summary, this.groundingCorpus(), this.facts);
        if (v.ok) {
          return this.finalizeFinish(hot, 'success', fin.summary);
        }
        if (!shouldRetryExecutor(this.verifyAttempts)) {
          return this.finishOk(hot, 'partial', `${fin.summary}\n\n[unverified against page: ${v.reason}]`);
        }
        this.verifyAttempts += 1;
        this.markDirty('finish rejected (ungrounded)');
        this.emit({ kind: 'log', ts: Date.now(), level: 'warn', message: `finish rejected (attempt ${this.verifyAttempts}): ${v.reason}` });
        // Corrective turn: nudge the executor to re-read or report honestly, then retry.
        const sp = await getScratchpad(this.taskId);
        await setScratchpad(
          this.taskId,
          `${sp}\n[VERIFICATION] Your finish was rejected: ${v.reason}. Do NOT open new tabs or re-read pages — all data is already in your workspace/observations. Call finish again with only values that appear exactly in the workspace, or mark them unavailable.`.slice(-this.bodyCaps.scratch),
        );
        continue;
      }
      if (execOut.result.advanceStep) {
        // A mid-plan PROSE answer (no tool call) is ungrounded by construction. Gate it through the
        // SAME grounding corpus as finish so the plan can't advance on a fabricated number; a
        // tool-produced advance is already page-grounded. The circuit breaker stops a model that
        // loops on bad prose.
        if (execOut.tool === 'answer') {
          const v = verifyFinish(execOut.result.content ?? '', this.groundingCorpus(), this.facts);
          if (!v.ok) {
            if (!shouldRetryExecutor(this.verifyAttempts)) {
              return this.finishOk(hot, 'partial', `${execOut.result.content ?? ''}\n\n[unverified against page: ${v.reason}]`);
            }
            this.verifyAttempts += 1;
            this.markDirty('mid-plan prose answer ungrounded');
            this.emit({ kind: 'log', ts: Date.now(), level: 'warn', message: `prose answer rejected (attempt ${this.verifyAttempts}): ${v.reason}` });
            const sp = await getScratchpad(this.taskId);
            await setScratchpad(
              this.taskId,
              `${sp}\n[VERIFICATION] Your answer was rejected: ${v.reason}. Use values already in your observations — do NOT open new tabs or re-extract pages you have already seen.`.slice(-this.bodyCaps.scratch),
            );
            continue;
          }
        }
        const ev = await this.evaluate(hot, step.id, execOut.result.content);
        this.captureFact(step, ev);
        if (ev.verdict !== 'PASS') this.markDirty('evaluator FAIL on a step');
        const next = walkPlan(hot.plan!, step.id, ev.verdict === 'PASS' ? 'done' : 'fail');
        hot = await this.applyPlan(hot, next.plan);
        this.breaker = resetForNewStep(this.breaker);
        // A new step gets a fresh self-correction budget and a clean fatal counter — these are
        // per-step concerns, like the breaker's windowed detectors (else a late step inherits an
        // earlier step's spent retries / a non-consecutive fatal and is wrongly cut short).
        this.verifyAttempts = 0;
        this.consecutiveFatal = 0;
        if (ev.finishVerdict && ev.finishSummary) {
          return this.finalizeFinish(hot, ev.finishVerdict, ev.finishSummary);
        }
        if (next.terminal) {
          const ok = ev.verdict === 'PASS';
          // If the executor wrote the answer as prose on the final step (no finish() call), that
          // text IS the deliverable — gate it like any success rather than discarding it for a
          // generic "Plan complete.".
          const answer = execOut.tool === 'answer' ? (execOut.result.content ?? '').trim() : '';
          if (ok && answer) {
            return this.finalizeFinish(hot, 'success', answer);
          }
          return this.finishOk(
            hot,
            ok ? 'success' : 'partial',
            ok
              ? 'Plan complete.'
              : 'Plan complete, but the final step did not pass — the result may be incomplete.',
          );
        }
        continue;
      }

      // A fatal tool result (blocked URL/scheme, tier denial) is unrecoverable; if the
      // executor keeps hitting one, stop promptly rather than burning turns to no-progress.
      if (execOut.result.fatal) {
        this.sawActionDenial = true; // remember it, so a later give-up salvages from what was read
        this.markDirty('tool/tier denial');
        this.consecutiveFatal += 1;
        if (this.consecutiveFatal >= 2) {
          // Salvage first: the facts may already be in observedText (e.g. read before the denials).
          return this.preferSalvageOnDenial(hot, {
            verdict: 'blocked',
            summary: `Blocked: ${(execOut.result.content ?? 'repeated unrecoverable tool error').slice(0, 500)}`,
          });
        }
      } else {
        this.consecutiveFatal = 0;
      }

      const verdict = checkBreaker(this.breaker);
      if (verdict.trip) {
        this.markDirty('circuit breaker trip');
        this.emit({ kind: 'breaker.trip', ts: Date.now(), reason: `${verdict.reason}: ${verdict.detail ?? ''}` });
        if (hot.replanCount >= (this.opts.maxReplans ?? 3) - 1) {
          return this.giveUp(hot, `Circuit breaker tripped (${verdict.reason}) and max replans reached.`);
        }
        hot = await this.replan(hot, `Breaker ${verdict.reason}: ${verdict.detail ?? ''}`);
        continue;
      }

      if (turn % 3 === 0) {
        const ev = await this.evaluate(hot, step.id, execOut.result.content);
        this.captureFact(step, ev); // periodic evals can also surface a grounded fact — dedups by text
        if (ev.finishVerdict && ev.finishSummary) {
          return this.finalizeFinish(hot, ev.finishVerdict, ev.finishSummary);
        }
        if (ev.verdict === 'FAIL' && ev.shouldReplan) {
          // T8 recovery bank first: a known error signature gets a single-step
          // steer fix (cheaper than a replan); unknown signatures fall through.
          if (this.tryBacktrackBank(ev.reason)) continue;
          // Backtrack first: retrying from a remembered earlier page is cheaper than a replan
          // and often enough (wrong product page → go back to the results list). Falls through
          // to the replan path when there's no usable history or the backtrack budget is spent.
          if (this.tryBacktrack()) continue;
          if (hot.replanCount >= (this.opts.maxReplans ?? 3) - 1) {
            return this.giveUp(hot, `Evaluator requested replan but max replans reached.`);
          }
          hot = await this.replan(hot, ev.reason);
        }
      }
    }

    return this.giveUp(hot, `Max turns (${maxTurns}) reached.`);
  }

  async abort(reason: string): Promise<void> {
    try {
      const hot = await this.refreshHotMaybe();
      if (!hot) return;
      this.emit({ kind: 'log', ts: Date.now(), level: 'warn', message: `Aborting: ${reason}` });
      await this.cleanupTabs(hot);
      await patchHot({ phase: 'ABORTED' });
      if (this.sessionId) {
        await saveSessionContext(this.sessionId, this.facts, `aborted: ${reason}`);
        await updateSessionTurnResult(this.sessionId, this.taskId, 'aborted', reason);
      }
    } catch (err) {
      this.log('error', `Abort cleanup error: ${(err as Error).message}`);
    }
  }

  private async plan(hot: AgentStateHot): Promise<AgentStateHot> {
    hot = await patchHot({ phase: 'PLANNING' });
    this.emit({ kind: 'role.start', ts: Date.now(), role: 'planner' });
    const t0 = performance.now();
    const agent = this.opts.settings.agent!;
    const out = await timed('planner', () =>
      runHeadChef(this.leadProvider, {
        ctx: this.commonCtx(hot),
        model: agent.brain.model,
        workflowRecipe: this.matchedWorkflow ? renderRecipe(this.matchedWorkflow) : undefined,
        recipeStepCount: this.matchedWorkflow?.steps.length,
        recipeRetryUsed: hot.recipeRetryUsed,
        signal: this.signal,
        numCtx: this.brainNumCtx,
      }),
    );
    if (out.promptEvalCount && out.evalCount) {
      this.observeTokens(buildPlannerMessages(this.commonCtx(hot)), out.promptEvalCount);
    }
    this.plannerNoGoal = !!out.noGoal;
    if (out.noGoal) {
      // Nothing to apply/emit — there's no real plan. runUntilTerminal checks plannerNoGoal
      // immediately after this call and finishes as 'blocked' before the loop ever starts.
      this.emit({ kind: 'role.end', ts: Date.now(), role: 'planner', ms: performance.now() - t0 });
      return hot;
    }
    hot = await this.applyPlan(hot, out.plan);
    // The recipe-parity retry (inside runPlanner) is bounded to once per TASK, not once per
    // runPlanner call — persist onto the shared hot state so a later outer replan() (which calls
    // runPlanner again from scratch) does not re-trigger it.
    if (out.retryFired) hot = await patchHot({ recipeRetryUsed: true });
    this.emit({ kind: 'planner.plan', ts: Date.now(), plan: out.plan });
    this.emit({ kind: 'role.end', ts: Date.now(), role: 'planner', ms: performance.now() - t0 });
    return hot;
  }

  private async replan(hot: AgentStateHot, reason: string): Promise<AgentStateHot> {
    this.markDirty('replan');
    hot = await patchHot({ phase: 'PLANNING', replanCount: hot.replanCount + 1 });
    this.emit({ kind: 'role.start', ts: Date.now(), role: 'planner' });
    const t0 = performance.now();
    const agent = this.opts.settings.agent!;
    const out = await timed('planner.replan', () =>
      runHeadChef(this.leadProvider, {
        ctx: this.commonCtx(hot),
        model: agent.brain.model,
        replanContext: reason,
        workflowRecipe: this.matchedWorkflow ? renderRecipe(this.matchedWorkflow) : undefined,
        recipeStepCount: this.matchedWorkflow?.steps.length,
        recipeRetryUsed: hot.recipeRetryUsed,
        signal: this.signal,
        numCtx: this.brainNumCtx,
      }),
    );
    hot = await this.applyPlan(hot, out.plan);
    // Same cross-call gate as plan() above — the outer replan loop itself may run up to
    // maxReplans times, and each of THOSE calls must also respect (and can also set) the flag.
    if (out.retryFired) hot = await patchHot({ recipeRetryUsed: true });
    this.emit({ kind: 'planner.plan', ts: Date.now(), plan: out.plan });
    this.emit({ kind: 'role.end', ts: Date.now(), role: 'planner', ms: performance.now() - t0 });
    this.breaker = resetForNewStep(this.breaker);
    return hot;
  }

  private async executeOne(hot: AgentStateHot, stepId: string): Promise<{
    result: ToolResult;
    tool: string;
  }> {
    const agent = this.opts.settings.agent!;
    hot = await patchHot({ phase: 'EXECUTING', currentStepId: stepId });
    this.emit({ kind: 'role.start', ts: Date.now(), role: 'executor', stepId });
    const t0 = performance.now();

    let scratch = await getScratchpad(this.taskId);
    let ctx = this.commonCtx(hot, scratch);
    const budgetCheck = checkBudget('executor', JSON.stringify(ctx), this.est, this.bodyNumCtx);
    if (budgetCheck.shouldCompact && scratch.length > 1_000) {
      const compacted = await this.compact(hot, scratch);
      scratch = compacted.summary;
      await setScratchpad(this.taskId, scratch);
      ctx = this.commonCtx(hot, scratch);
    }

    const toolCtx = this.buildToolCtx(hot, stepId);

    // Observe-then-act gate: within a step, block re-running the SAME observation
    // tool back-to-back (it looped aria.extract instead of acting); the other
    // observation tool stays available for the aria→vision fallback.
    if (this.observeGateStep !== stepId) {
      this.observeGateStep = stepId;
      this.lastObserveTool = null;
    }
    const blocked = this.lastObserveTool;
    const toolFilter = blocked ? (name: string) => name !== blocked : undefined;

    // T3 think-routing seam: single-tool turns skip thinking (fast path), multi-turn
    // plans and every-3rd turn think. Layered over the body provider so the executor's
    // own hardcoded thinking flag is overridden per-turn without touching its code.
    const stepCount = hot.plan?.steps.length ?? 1;
    const thinkRoute = routeThink({ stepCount, turn: this.turns + 1 });
    const thinkProvider = withThinkingOverride(
      this.helperProvider,
      thinkRoute === 'THINK',
      thinkRoute === 'THINK' ? 'medium' : undefined,
    );

    const out = await timed('executor', () =>
      runHelper(thinkProvider, {
        ctx,
        model: agent.body.model,
        registry: this.opts.registry,
        toolCtx,
        toolFilter,
        signal: this.signal,
        numCtx: this.bodyNumCtx,
        structured: !!this.opts.settings.structuredToolCalls,
      }),
    );

    this.lastObserveTool = OBSERVATION_TOOLS.has(out.tool) ? out.tool : null;

    if (out.promptEvalCount && out.evalCount) {
      this.observeTokens(JSON.stringify(ctx), out.promptEvalCount);
    }

    // Surface the executor's action BEFORE the auto-read below, so the timeline
    // reads in chronological order: action → its result → auto-read of the new page.
    this.emit({ kind: 'tool.call', ts: Date.now(), tool: out.tool, args: out.args });
    this.emit({
      kind: 'tool.result',
      ts: Date.now(),
      tool: out.tool,
      ok: out.result.ok,
      content: (out.result.content ?? '').slice(0, 2_000),
    });

    await this.autoObserveAfterNavigation(out, toolCtx);
    await this.recordTurn(out, scratch);

    this.emit({ kind: 'role.end', ts: Date.now(), role: 'executor', ms: performance.now() - t0 });

    if (out.result.fatal) {
      await sleep(10);
    }

    return { result: out.result, tool: out.tool };
  }

  /** Build the per-turn tool context (identity + finding sink) for the executor. */
  private buildToolCtx(hot: AgentStateHot, stepId: string): ToolContext {
    return {
      taskId: this.taskId,
      signal: this.signal,
      hot,
      settings: this.opts.settings,
      ollama: this.opts.ollama,
      numCtx: this.bodyNumCtx,
      emit: this.emit.bind(this),
      addFinding: async (kind, data, sid) => {
        await addFinding({
          taskId: this.taskId,
          stepId: sid ?? stepId,
          ts: Date.now(),
          kind,
          data: redactDeep(data),
        });
      },
    };
  }

  /** After a navigating action, re-read the new page FOR the model (small models
   *  fail to re-read), dismiss a consent wall if present (tier-gated), and refresh
   *  CURRENT PAGE CONTENT — emitting a log so the grounding is never invisible. */
  private async autoObserveAfterNavigation(out: ExecutorOut, toolCtx: ToolContext): Promise<void> {
    const navigated =
      out.result.ok &&
      (NAVIGATING_TOOLS.has(out.tool) ||
        (out.tool === 'tab.type' && !!(out.args as { submit?: unknown }).submit));
    const navTabId =
      typeof (out.args as { tabId?: unknown }).tabId === 'number'
        ? (out.args as { tabId: number }).tabId
        : out.result.data && typeof out.result.data.tabId === 'number'
          ? (out.result.data.tabId as number)
          : undefined;
    if (!navigated) return;
    if (navTabId === undefined) {
      this.emit({
        kind: 'log',
        ts: Date.now(),
        level: 'warn',
        message: 'navigated but could not resolve a tabId to re-read — the next turn keeps the previous page content',
      });
      return;
    }

    await waitForTabSettled(navTabId); // condition-based wait, not a fixed delay
    const obs = await this.opts.registry.dispatch('aria.extract', { tabId: navTabId }, toolCtx).catch(() => null);
    if (!(obs && obs.ok && obs.content)) {
      this.emit({
        kind: 'log',
        ts: Date.now(),
        level: 'warn',
        message:
          'auto-read after navigation returned no page content (page may still be loading) — the next turn has no fresh read',
      });
      return;
    }
    let obsUrl = obs.data && typeof obs.data.url === 'string' ? (obs.data.url as string) : this.lastRead?.url;
    this.setLastRead({ tool: 'aria.extract', url: obsUrl, content: obs.content.slice(0, this.bodyCaps.page) });
    this.lastObserveTool = 'aria.extract'; // nudge: act on the fresh page, don't re-extract
    this.recordObserved(obs.content, obsUrl);
    // Auto-save workspace entry — the model sees these in context without remembering to call workspace.add
    await this.autoSaveWorkspace(obs.content, obsUrl).catch(() => undefined);
    this.emit({
      kind: 'log',
      ts: Date.now(),
      level: 'info',
      message: `auto-read page after navigation${obsUrl ? ` (${obsUrl})` : ''} — ${obs.content.length} chars`,
    });

    // Anti-bot block (captcha/interstitial/access-denied wall)? Pause and wait for the human to
    // resolve it in the visible tab — never attempt to solve it. No timeout: this can
    // legitimately take minutes, and the existing Stop control is the escape hatch if the user
    // wants to abandon the run instead of waiting. detectAntiBotBlock is a deterministic,
    // pattern-based check (not exhaustive) — a miss just means no pause, never a wrong action;
    // a false positive here is fully recoverable via Stop, never a silent hang.
    let block = detectAntiBotBlock(obs.content);
    if (block) {
      this.emit({ kind: 'antibot.blocked', ts: Date.now(), label: block.label });
      await patchHot({ phase: 'BLOCKED' });
      const pollMs = this.opts.antiBotPollMs ?? 5_000;
      let resolved = obs; // obs is non-null here (guarded above); only ever reassigned below from
                           // an already-non-null `polled`, so `resolved` stays provably non-null
                           // throughout the loop — no non-null assertions needed anywhere.
      while (block) {
        await sleep(pollMs, this.signal);
        const polled = await this.opts.registry.dispatch('aria.extract', { tabId: navTabId }, toolCtx).catch(() => null);
        if (!(polled && polled.ok && polled.content)) continue; // inconclusive read — keep polling, don't resolve
        resolved = polled;
        block = detectAntiBotBlock(polled.content);
      }
      obsUrl = resolved.data && typeof resolved.data.url === 'string' ? (resolved.data.url as string) : obsUrl;
      this.setLastRead({ tool: 'aria.extract', url: obsUrl, content: resolved.content.slice(0, this.bodyCaps.page) });
      this.recordObserved(resolved.content, obsUrl);
      await this.autoSaveWorkspace(resolved.content, obsUrl).catch(() => undefined);
      this.emit({ kind: 'antibot.resolved', ts: Date.now() });
      await patchHot({ phase: 'EXECUTING' });
      return;
    }

    // Consent/cookie wall? Dismiss it (privacy-preferring) so the model reads the
    // real page — but only where the user upgraded this domain to act.
    const consent = findConsentDismiss(obs.content);
    if (!(consent && this.canActUrl(obsUrl))) return;
    await this.opts.registry.dispatch('tab.click', { tabId: navTabId, elementIndex: consent.index }, toolCtx).catch(() => null);
    this.emit({
      kind: 'log',
      ts: Date.now(),
      level: 'info',
      message: `dismissed consent overlay (${consent.kind}): "${consent.label}"`,
    });
    await waitForTabSettled(navTabId);
    const after = await this.opts.registry.dispatch('aria.extract', { tabId: navTabId }, toolCtx).catch(() => null);
    if (after && after.ok && after.content) {
      const afterUrl = after.data && typeof after.data.url === 'string' ? (after.data.url as string) : obsUrl;
      this.setLastRead({ tool: 'aria.extract', url: afterUrl, content: after.content.slice(0, this.bodyCaps.page) });
      this.recordObserved(after.content, afterUrl);
      await this.autoSaveWorkspace(after.content, afterUrl).catch(() => undefined);
    }
  }

  /** Save page content to workspace automatically after reading it.
   *  The model sees workspace summaries in its context on every turn, so it
   *  doesn't need to remember to call workspace.add. Non-critical: swallow errors. */
  private async autoSaveWorkspace(content: string, url?: string): Promise<void> {
    try {
      const title = url
        ? `Page: ${new URL(url).pathname.replace(/\/$/, '').split('/').filter(Boolean).pop() || url}`
        : 'Page: (unknown)';
      const body = content.slice(0, 800).replace(/\s+/g, ' ').trim();
      const { ['agent.workspace']: raw } = await chrome.storage.local.get('agent.workspace');
      const entries = Array.isArray(raw) ? (raw as Array<{ title: string; content: string; url?: string }>) : [];
      entries.push({ title, content: body, url });
      this.workspaceCache = entries.slice(-50);
      await chrome.storage.local.set({ 'agent.workspace': this.workspaceCache });
    } catch { /* non-critical */ }
  }

  /** Per-turn bookkeeping: circuit breaker, carry-forward of a page read, the
   *  scratchpad tail, recent-actions window, and the workflow trace. */
  private async recordTurn(out: ExecutorOut, scratch: string): Promise<void> {
    const hash = actionHash(out.tool, out.args);
    const foundFinding =
      out.result.ok &&
      ((out.result.data && Object.keys(out.result.data).length > 0) || (out.result.content?.length ?? 0) > 80);
    this.breaker = recordAction(this.breaker, hash, !!out.result.unknownTool, !!foundFinding);

    // Carry the full page read forward — the scratchpad keeps only an 800-char tail,
    // far too little to synthesize a product/price list from on a later turn.
    if (READING_TOOLS.has(out.tool) && out.result.ok && (out.result.content?.length ?? 0) > 0) {
      const data = out.result.data;
      const url = data && typeof data.url === 'string' ? data.url : undefined;
      this.setLastRead({ tool: out.tool, url, content: (out.result.content ?? '').slice(0, this.bodyCaps.page) });
      this.recordObserved(out.result.content ?? '', url);
    }

    // redact() before persisting: tool args (e.g. tab.type for a job application) can carry the
    // user's email/phone/SSN, and the scratchpad is written to IndexedDB and re-fed into prompts.
    const turnNote = redact(
      `[${new Date().toISOString()}] ${out.tool}(${JSON.stringify(out.args).slice(0, 200)}) -> ${(out.result.content ?? '').slice(0, 800)}`,
    );
    await setScratchpad(this.taskId, `${scratch}\n${turnNote}`.slice(-this.bodyCaps.scratch));

    this.recentActions.push({ tool: out.tool, args: out.args, ok: out.result.ok, content: out.result.content ?? '', ts: Date.now() });
    if (this.recentActions.length > 5) this.recentActions.shift();
    this.trace.push({ tool: out.tool, args: out.args });
  }

  /** Centralized lastRead setter — records the outgoing distinct page state into pageHistory
   *  (url-differentiated) so backtracking has known-good positions to restore. */
  private setLastRead(read: { tool: string; url?: string; content: string }): void {
    if (this.lastRead && read.url && this.lastRead.url && this.lastRead.url !== read.url) {
      this.pageHistory.push(this.lastRead);
      if (this.pageHistory.length > 3) this.pageHistory.shift();
    }
    this.lastRead = read;
  }

  /** Evaluator-driven backtracking (width-2 retry): when the evaluator FAILs a step and asks
   *  for a replan, first try resuming from the most recent DISTINCT earlier page with a
   *  corrective steer note — a cheap second attempt from a known-good position before spending
   *  a planner call and one of maxReplans. Returns true when a backtrack was applied. */
  private tryBacktrack(): boolean {
    if (!this.pageHistory.length || this.backtracksUsed >= 2) return false;
    let idx = this.pageHistory.length - 1;
    while (idx >= 0 && this.pageHistory[idx].url && this.pageHistory[idx].url === this.lastRead?.url) idx--;
    if (idx < 0) return false; // every remembered page is where we already are
    const restored = this.pageHistory.splice(idx, 1)[0];
    this.setLastRead(restored);
    this.backtracksUsed += 1;
    this.markDirty('backtrack');
    this.observeGateStep = null; // fresh observe budget on the restored page
    this.lastObserveTool = null;
    this.log('info', `backtrack: restored an earlier page${restored.url ? ` (${restored.url})` : ''} — retrying the step from there instead of replanning`);
    this.steer(
      `Backtrack: you are back on an earlier page${restored.url ? ` (${restored.url})` : ''}. The current approach FAILED — try a DIFFERENT link, tab, or method from here.`,
    );
    return true;
  }

  /** T8 PALADIN recovery bank: on an evaluator FAIL, try a single-step bank fix
   *  (steer + best-effort backtrack) before burning a full replan. Returns true
   *  when a bank entry matched (caller retries the step); false lets the existing
   *  backtrack → replan path run. Marks the run dirty so a recovered run is never
   *  distilled into a recipe.
   *  T8 DEBT (deferred to scheduler, NOT fixed here): the bank retries until
   *  maxTurns with no dedicated bank budget — a scheduler should bound bank
   *  attempts per run. */
  private tryBacktrackBank(reason: string): boolean {
    const hit = lookupRecovery(reason ?? '');
    if (!hit) return false;
    this.markDirty(`recovery:${hit.pattern}`);
    this.steer(`Recovery: ${hit.fix}`);
    this.tryBacktrack(); // best-effort: also restore the earlier page when there is one
    return true;
  }

  private async evaluate(hot: AgentStateHot, stepId: string, lastResult: string) {
    const agent = this.opts.settings.agent!;
    await patchHot({ phase: 'EVALUATING' });
    const step = hot.plan!.steps.find((s) => s.id === stepId)!;
    // Pass the scratchpad so the evaluator can see data gathered on EARLIER turns — otherwise it
    // judges only the current page and mis-FAILs a step whose data was gathered before the agent
    // moved on (the root of the replan storms).
    const scratch = await getScratchpad(this.taskId);
    this.emit({ kind: 'role.start', ts: Date.now(), role: 'evaluator', stepId });
    const t0 = performance.now();
    const ev = await timed('evaluator', () =>
      runSousChef(this.leadProvider, {
        ctx: this.commonCtx(hot, scratch),
        model: agent.brain.model,
        lastExecutorResult: lastResult,
        step,
        signal: this.signal,
        numCtx: this.brainNumCtx,
      }),
    );
    this.emit({ kind: 'evaluator.verdict', ts: Date.now(), verdict: ev.verdict, reason: ev.reason });
    this.emit({ kind: 'role.end', ts: Date.now(), role: 'evaluator', ms: performance.now() - t0 });
    return ev;
  }

  /** Promote the evaluator's grounded datum into the durable ledger (in-memory + persisted).
   *  No-ops on a null/ungrounded/duplicate fact — purely additive. */
  private captureFact(step: Step, ev: Verdict): void {
    if (!ev.fact) return;
    const before = this.facts.length;
    this.facts = addGroundedFact(
      this.facts,
      { step: step.description, text: ev.fact, url: this.lastRead?.url },
      this.groundingCorpus(),
    );
    if (this.facts.length > before) {
      const f = this.facts[this.facts.length - 1];
      void addFinding({ taskId: this.taskId, kind: 'fact', ts: Date.now(), stepId: step.id, data: redactDeep(f) });
    }
  }

  private async compact(hotState: AgentStateHot, scratch: string) {
    const agent = this.opts.settings.agent!;
    await patchHot({ phase: 'COMPACTING' });
    this.emit({ kind: 'role.start', ts: Date.now(), role: 'compactor' });
    const t0 = performance.now();
    const out = await timed('compactor', () =>
      runHelperCompaction(this.helperProvider, {
        goal: hotState.goal,
        toolCatalog: this.opts.registry.describe(),
        scratchpad: scratch,
        model: agent.body.model,
        signal: this.signal,
        numCtx: this.bodyNumCtx,
      }),
    );
    this.emit({ kind: 'compaction', ts: Date.now(), before: out.charsBefore, after: out.charsAfter });
    this.emit({ kind: 'role.end', ts: Date.now(), role: 'compactor', ms: performance.now() - t0 });
    return out;
  }

  private recordObserved(content: string, url?: string): void {
    if (url && /^https?:\/\//i.test(url)) this.sourceUrls.add(url);
    if (!content) return;
    this.observedText = `${this.observedText}\n${content}`.slice(-this.brainCaps.observed);
  }

  /** Apply a pre-built plan without calling the planner LLM (fast path). */
  private async seedPlanInto(
    hot: AgentStateHot,
    steps: Array<{ description: string; successCriteria: string; toolHint?: string }>,
  ): Promise<AgentStateHot> {
    hot = await patchHot({ phase: 'PLANNING' });
    const plan = newPlan(steps);
    hot = await this.applyPlan(hot, plan);
    this.emit({ kind: 'planner.plan', ts: Date.now(), plan });
    return hot;
  }

  /** True if this URL's domain is upgraded to click-only or higher — gates the
   *  harness's consent auto-dismiss (auto-accepting/rejecting cookies has privacy weight).
   *  The opt-in bypass un-gates it for any (non-blocked) site. */
  private canActUrl(url: string | undefined): boolean {
    if (!url || isBlockedUrl(url)) return false;
    if (this.opts.settings.bypassDomainTiers) return true;
    return TIER_ORDER[getDomainTier(hostFor(url), this.opts.settings.domainTiers)] >= TIER_ORDER['click-only'];
  }

  /** Extract persona from step toolHint (e.g. "persona:extractor" → "extractor"). */
  private personaFromStep(hot: AgentStateHot): string | undefined {
    const step = hot.plan && hot.currentStepId ? hot.plan.steps.find((s) => s.id === hot.currentStepId) : null;
    const hint = step?.toolHint ?? '';
    const m = hint.match(/persona:(\w+)/);
    return m?.[1];
  }

  private commonCtx(hot: AgentStateHot, scratchpad?: string) {
    return {
      goal: hot.goal,
      toolCatalog: this.opts.registry.describe(),
      plan: hot.plan,
      currentStepId: hot.currentStepId,
      ownedTabs: hot.ownedTabs,
      scratchpad,
      profileBlock: renderProfileBlock(this.opts.settings.profileJson),
      steerNotes: this.steerNotes.length ? [...this.steerNotes] : undefined,
      preferences: (this.opts.settings.preferences ?? '').trim() || undefined,
      priorSummary: this.priorSummary || undefined,
      pageContentBlock: this.lastRead
        ? wrapPageContent(
            `${this.lastRead.tool}${this.lastRead.url ? ` url=${this.lastRead.url}` : ''}`,
            this.lastRead.content.slice(0, 6_000), // 6K fits 120s timeout on P2200; full 12K in workspace + observedText for grounding
          )
        : undefined,
      persona: this.personaFromStep(hot),
      recentActions: this.recentActions
        .map(
          (a) =>
            `- ${a.ok ? '✓' : '✗'} ${a.tool}(${redact(JSON.stringify(a.args).slice(0, 80))}) → ${redact(a.content.slice(0, 200))}`,
        )
        .join('\n'),
      findingsBlock: renderFacts(this.facts),
      workspaceBlock: this.workspaceCache.length
        ? `WORKSPACE (pages read this task):\n${this.workspaceCache
            .map((e) => `  ${e.title}${e.url ? `\n    URL: ${e.url}` : ''}\n    ${e.content.slice(0, 300).replace(/\n/g, '\n    ')}`)
            .join('\n\n')}`
        : undefined,
    };
  }

  private observeTokens(text: string | object, promptEvalCount: number) {
    const chars = typeof text === 'string' ? text.length : JSON.stringify(text).length;
    this.est.observe(chars, promptEvalCount);
  }

  private async applyPlan(hot: AgentStateHot, plan: Plan): Promise<AgentStateHot> {
    const first = plan.steps.find((s) => s.status === 'active') ?? plan.steps[0];
    const next = await patchHot({ plan, currentStepId: first?.id ?? null });
    return next;
  }

  private async refreshHot(prev: AgentStateHot): Promise<AgentStateHot> {
    const cur = await this.refreshHotMaybe();
    return cur ?? prev;
  }

  private async refreshHotMaybe(): Promise<AgentStateHot | null> {
    try {
      return await loadHot();
    } catch {
      return null;
    }
  }

  /** Gate a data-bearing executor/evaluator finish, then reconcile a "field is missing" claim
   *  against the FULL corpus. NOT used by the salvage paths (giveUp/preferSalvageOnDenial), which
   *  already answer from the corpus. */
  private async finalizeFinish(hot: AgentStateHot, verdict: string, summary: string): Promise<RunResult> {
    const g = gateFinishSummary(verdict, summary, this.groundingCorpus(), this.facts);
    const reconciled = g.verdict === 'success' ? await this.reconcileMissingFromCorpus(hot, g.summary) : g.summary;
    return this.finishOk(hot, g.verdict, reconciled);
  }

  /** A finish that reports a requested field as ABSENT may have overlooked data the agent already
   *  gathered — observedText holds EVERY read this task (incl. search-result snippets), but the
   *  executor only ever sees the LAST page. So re-answer the goal from the full corpus and adopt
   *  that answer ONLY if it fills the gap (no longer claims something missing) and is grounded.
   *  Returns the original summary unchanged when there's no missing-claim or no better answer. */
  private async reconcileMissingFromCorpus(hot: AgentStateHot, summary: string): Promise<string> {
    if (!mentionsMissing(summary)) return summary;
    const corpusAnswer = (await this.synthesizeFromObserved(hot))?.trim();
    // Adopt the corpus answer ONLY if it is a substantive answer that no longer reports a gap.
    // A short/junk answer (or one that still says "not shown") means the field is genuinely
    // absent — keep the honest original (preserves absent-field honesty, e.g. an icon-only rating).
    if (corpusAnswer && corpusAnswer.length >= 40 && !mentionsMissing(corpusAnswer)) {
      const g = gateFinishSummary('success', corpusAnswer, this.groundingCorpus(), this.facts);
      if (g.verdict === 'success') {
        this.markDirty('finish re-answered from corpus');
        this.emit({
          kind: 'log',
          ts: Date.now(),
          level: 'info',
          message: 'finish re-answered from the full corpus (a field reported missing was found in an earlier read)',
        });
        return g.summary;
      }
    }
    return summary;
  }

  /** Mark this run as "messy" so it won't be distilled into a recipe. Called on any friction —
   *  replan, evaluator FAIL, tier/fatal denial, breaker trip, finish rejection. First reason wins. */
  private markDirty(reason: string): void {
    if (!this.runDirty) {
      this.runDirty = true;
      this.dirtyReason = reason;
    }
  }

  /** Settle the recipe that drove this run (user OR auto — builtins are untouched, they're curated,
   *  not learned). A CLEAN, non-redundant success proves a USER recipe (trust + snapshot); auto
   *  recipes have no trust concept, so a clean run needs no bookkeeping here. ANY failure/messy/
   *  redundant run quarantines whichever recipe drove it: a user recipe rolls back to last-good (or
   *  deletes if brand-new); an auto recipe always deletes outright — it never has a last-good (it
   *  wasn't hand-edited), so it gets exactly one chance and can be re-learned from a future clean
   *  run. This is the recipe-safety "catch": a bad recipe (authored or learned) can't keep being used. */
  private async settleRecipe(verdict: string): Promise<void> {
    const wf = this.matchedWorkflow;
    if (!wf || (wf.origin !== 'user' && wf.origin !== 'auto')) return;
    const cleanSuccess = verdict === 'success' && !this.runDirty && !traceHasRedundancy(this.trace);
    try {
      if (cleanSuccess) {
        if (wf.origin === 'user') {
          await markWorkflowTrusted(wf.id);
          this.emit({ kind: 'log', ts: Date.now(), level: 'info', message: `Recipe "${wf.id}" confirmed (clean run).` });
        }
        // origin === 'auto': already proven once (that's how it got learned) — nothing to record.
      } else {
        const res = await quarantineWorkflow(wf.id);
        if (res === 'rolledback') {
          this.emit({ kind: 'log', ts: Date.now(), level: 'warn', message: `Recipe "${wf.id}" didn't work — rolled back to its last good version.` });
        } else if (res === 'deleted') {
          this.emit({ kind: 'log', ts: Date.now(), level: 'warn', message: `Recipe "${wf.id}" didn't work and wasn't proven — removed it.` });
        }
      }
    } catch {
      /* settling is best-effort, never fatal */
    }
  }

  private async finishOk(
    hot: AgentStateHot,
    verdict: string,
    summary: string,
  ): Promise<RunResult> {
    await this.cleanupTabs(hot);
    await patchHot({ phase: 'DONE' });
    if (this.sessionId) {
      await saveSessionContext(this.sessionId, this.facts, `${verdict}: ${summary}`);
      await updateSessionTurnResult(this.sessionId, this.taskId, verdict, summary);
    }
    await this.settleRecipe(verdict);
    // Auto-learn ONLY from a success that NO recipe guided — i.e. a genuinely new flow. If a recipe
    // (user/builtin/auto) already drove the run, re-recording is redundant and worse: saveWorkflow's
    // near-duplicate dedup would clobber the very user recipe that just succeeded. The gates below
    // (clean + non-redundant) still apply to those unguided runs.
    if (verdict === 'success' && !this.matchedWorkflow) {
      if (this.runDirty) {
        this.emit({ kind: 'log', ts: Date.now(), level: 'info', message: `Recipe not saved (run not clean: ${this.dirtyReason})` });
      } else if (traceHasRedundancy(this.trace)) {
        this.emit({ kind: 'log', ts: Date.now(), level: 'info', message: 'Recipe not saved (run had redundant steps)' });
      } else if (!traceWorthLearning(this.trace)) {
        this.emit({ kind: 'log', ts: Date.now(), level: 'info', message: 'Recipe not saved (task was simple — answered without navigating a page)' });
      } else {
        try {
          const wf = traceToWorkflow(`auto:${ulid()}`, hot.goal, deriveDomain(this.trace, hot.goal), this.trace);
          if (wf) await saveWorkflow(wf);
        } catch {
          /* recording is best-effort, never fatal */
        }
      }
    }
    this.emit({ kind: 'finish', ts: Date.now(), verdict, summary, sources: [...this.sourceUrls].slice(0, 5) });
    return { phase: 'DONE', summary, verdict, turns: this.turns, replans: hot.replanCount };
  }

  private async abortNow(hot: AgentStateHot, reason: string): Promise<RunResult> {
    await this.cleanupTabs(hot);
    await patchHot({ phase: 'ABORTED' });
    if (this.sessionId) {
      await saveSessionContext(this.sessionId, this.facts, `aborted: ${reason}`);
      await updateSessionTurnResult(this.sessionId, this.taskId, 'aborted', reason);
    }
    await this.settleRecipe('aborted'); // a failed run quarantines whichever recipe drove it
    this.emit({ kind: 'finish', ts: Date.now(), verdict: 'aborted', summary: reason });
    return { phase: 'ABORTED', summary: reason, verdict: 'aborted', turns: this.turns, replans: hot.replanCount };
  }

  /** The agent ran out of road (max replans/turns) — but it may have ALREADY read what the goal
   *  needs (the plan-tracking just thrashed). Try one final answer from everything observed before
   *  giving up empty; only abort if nothing was gathered. */
  private async giveUp(hot: AgentStateHot, reason: string): Promise<RunResult> {
    this.emit({ kind: 'log', ts: Date.now(), level: 'warn', message: `${reason} Trying a final answer from what was gathered.` });
    const answer = await this.synthesizeFromObserved(hot);
    if (answer) {
      const g = gateFinishSummary('partial', answer, this.groundingCorpus(), this.facts);
      return this.finishOk(hot, g.verdict, g.summary);
    }
    return this.abortNow(hot, reason);
  }

  /** A non-success exit AFTER an action/tier denial often means the agent gave up on the last
   *  mile while the facts were ALREADY gathered (e.g. search snippets in observedText, then a
   *  read-only click was denied). Prefer a grounded answer salvaged from what was read; fall back
   *  to the honest blocked/failed result if nothing was gathered OR no denial occurred. Gating on
   *  an actual denial keeps genuine "not found" finishes honest (they never salvage). */
  private async preferSalvageOnDenial(
    hot: AgentStateHot,
    fallback: { verdict: string; summary: string },
  ): Promise<RunResult> {
    if (this.sawActionDenial) {
      const salvaged = await this.synthesizeFromObserved(hot);
      if (salvaged) {
        const g = gateFinishSummary('partial', salvaged, this.groundingCorpus(), this.facts);
        return this.finishOk(hot, g.verdict, g.summary);
      }
    }
    return this.finishOk(hot, fallback.verdict, fallback.summary);
  }

  /** One model call that answers the goal from the observed corpus (everything read this task).
   *  Returns null if nothing meaningful was gathered. The answer is grounding-gated by the caller. */
  private async synthesizeFromObserved(hot: AgentStateHot): Promise<string | null> {
    const agent = this.opts.settings.agent!;
    const corpus = this.groundingCorpus().trim();
    if (corpus.length < 40) return null; // nothing was read — nothing to salvage
    try {
      const resp = await this.opts.ollama.chatOnce({
        model: agent.body.model,
        messages: [
          {
            role: 'system',
            content:
              "Answer the user's GOAL using ONLY the notes gathered while browsing (below). State the answer directly and concisely. Use only facts present in the notes — never invent a number or name. If the GOAL is a comparison, use the SAME basis for every item (e.g. each city's primary 'city' population — do NOT mix city and metro-area figures). If the notes don't fully answer the GOAL, give the best partial answer and say what's missing.",
          },
          {
            role: 'user',
            content: `GOAL: ${hot.goal}\n\nGATHERED NOTES (the pages you read this task):\n${corpus.slice(-this.bodyCaps.salvage)}\n\nAnswer the GOAL now from these notes.`,
          },
        ],
        thinking: false,
        numCtx: this.bodyNumCtx,
        timeoutMs: 300_000,
        signal: this.signal,
      });
      const text = (resp.message.content ?? '').trim();
      return text.length ? text : null;
    } catch {
      return null;
    }
  }

  private async cleanupTabs(hot: AgentStateHot): Promise<void> {
    const c = (globalThis as { chrome?: typeof chrome }).chrome;
    if (!c?.tabs?.remove) return;
    const tabs = [...hot.ownedTabs];
    if (!tabs.length) return;
    const deadline = Promise.race([
      Promise.all(
        tabs.map(
          (id) =>
            new Promise<void>((resolve) => {
              try {
                c.tabs!.remove(id, () => {
                  void c.runtime?.lastError;
                  resolve();
                });
              } catch {
                resolve();
              }
            }),
        ),
      ),
      sleep(2_000),
    ]);
    await deadline;
    await patchHot({ ownedTabs: [] });
  }

  private log(level: 'info' | 'warn' | 'error', message: string) {
    this.emit({ kind: 'log', ts: Date.now(), level, message });
  }

  private emit(ev: TimelineEvent) {
    const safe = redactEvent(ev);
    this.opts.emit(safe);
    void appendEvent(this.taskId, safe);
  }

  private assertNotAborted() {
    if (this.signal.aborted) throw new DOMException('Aborted', 'AbortError');
  }

  static async cleanupStaleAndExit(): Promise<void> {
    await clearHot();
  }
}
