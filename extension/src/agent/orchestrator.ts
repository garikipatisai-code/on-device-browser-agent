// Orchestrator: state machine ties everything together.
// IDLE → PLANNING → EXECUTING → EVALUATING → EXECUTING (next step) → ... → DONE | ABORTED.

import type { OllamaClient } from '@/background/ollama';
import type { Plan, Settings, Step, TimelineEvent } from '@/shared/messages';
import {
  type AgentStateHot,
  _setHot,
  addFinding,
  appendEvent,
  clearHot,
  getScratchpad,
  loadHot,
  patchHot,
  setScratchpad,
  touchHot,
} from '@/background/state_store';
import type { ToolRegistry } from './tools/registry';
import type { ToolContext, ToolResult } from './tools/registry';
import { runPlanner } from './roles/planner';
import { runExecutor } from './roles/executor';
import { runEvaluator, type Verdict } from './roles/evaluator';
import { addGroundedFact, groundingCorpus, renderFacts, type Fact } from './facts';
import { runCompactor } from './roles/compactor';
import { actionHash, TokenRatioEstimator, ulid } from './util';
import { checkBudget, NUM_CTX } from './budget';
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
import { redact, redactDeep } from './safety/redact';
import { ungroundedNumbers } from './verify/grounding';
import { findConsentDismiss } from './tools/browser/consent';
import { getDomainTier, hostFor, isBlockedUrl, TIER_ORDER } from './safety/domain_tiers';
import { sleep } from '@/background/signal';
import { waitForTabSettled } from './tools/browser/tab';
import { clearSearchResults } from './tools/browser/search';
import { matchWorkflow, renderRecipe, loadWorkflows, saveWorkflow, traceToWorkflow, traceHasRedundancy, traceWorthLearning, markWorkflowTrusted, quarantineWorkflow, deriveDomain, type Workflow } from './workflow_memory';
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

/** The exact shape the executor role returns (tool, args, result, eval counts). */
type ExecutorOut = Awaited<ReturnType<typeof runExecutor>>;

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
  // Full content of the most recent page read (aria.extract / vision.read / search).
  // Re-injected into every executor turn so synthesis/report steps can see the data.
  private lastRead: { tool: string; url?: string; content: string } | null = null;
  // Everything read this task (capped) — the corpus the finish-verifier grounds against.
  private observedText = '';
  private facts: Fact[] = [];
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

  constructor(private opts: OrchestratorOpts) {
    this.signal = opts.signal ?? new AbortController().signal;
  }

  async start(goal: string): Promise<AgentStateHot> {
    const trimmed = goal.trim();
    if (!trimmed) throw new Error('goal is empty');
    this.est.reset();
    this.breaker = newBreakerState();
    this.recentActions = [];
    this.lastRead = null;
    this.observedText = '';
    this.facts = [];
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
    this.dirtyReason = '';
    this.matchedWorkflow = matchWorkflow(trimmed, await loadWorkflows());
    this.taskId = ulid();
    const hot = await _setHot(trimmed);
    await setScratchpad(this.taskId, '');
    this.log('info', `Task started: ${trimmed}`);
    if (this.matchedWorkflow) this.log('info', `Workflow recipe matched: ${this.matchedWorkflow.id}`);
    return hot;
  }

  /** Inject a mid-run user correction ("steer"). Surfaced as high-priority guidance on the next
   *  planner/executor turn — the user redirecting a live task without aborting it. Best-effort:
   *  blank input is ignored; bounded to the last few so guidance can't grow unbounded. */
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

      if (execOut.result.finish) {
        const fin = execOut.result.finish;
        // Honest failures (blocked/failed) aren't fabrication risks. A 'partial' carries data,
        // so route it through the grounding gate too (flags an ungrounded number, no retry).
        if (fin.verdict !== 'success') {
          // But the model may be conceding defeat while observedText ALREADY holds the answer (it
          // hit a read-only/tier denial after the facts were read). Prefer a grounded salvage over
          // the defeatist message; preferSalvageOnDenial no-ops (keeps this verdict) if no denial
          // occurred — so a genuine "not found" stays an honest blocked/failed.
          return this.preferSalvageOnDenial(hot, this.gateFinishSummary(fin.verdict, fin.summary));
        }
        const v = this.verifyFinish(fin.summary);
        if (v.ok) {
          return this.finishOk(hot, 'success', fin.summary);
        }
        this.verifyAttempts += 1;
        this.markDirty('finish rejected (ungrounded)');
        this.emit({ kind: 'log', ts: Date.now(), level: 'warn', message: `finish rejected (attempt ${this.verifyAttempts}): ${v.reason}` });
        if (this.verifyAttempts >= 2) {
          return this.finishOk(hot, 'partial', `${fin.summary}\n\n[unverified against page: ${v.reason}]`);
        }
        // Corrective turn: nudge the executor to re-read or report honestly, then retry.
        const sp = await getScratchpad(this.taskId);
        await setScratchpad(
          this.taskId,
          `${sp}\n[VERIFICATION] Your finish was rejected: ${v.reason}. Re-read the page (aria.extract / vision.read) and correct the answer, or report those value(s) as not available on the page. Do NOT repeat the unsupported claim.`.slice(-12_000),
        );
        continue;
      }
      if (execOut.result.advanceStep) {
        // A mid-plan PROSE answer (no tool call) is ungrounded by construction. Gate it through the
        // SAME grounding corpus as finish so the plan can't advance on a fabricated number; a
        // tool-produced advance is already page-grounded. The circuit breaker stops a model that
        // loops on bad prose.
        if (execOut.tool === 'answer') {
          const ung = ungroundedNumbers(execOut.result.content ?? '', groundingCorpus(this.observedText, this.facts));
          if (ung.length) {
            this.markDirty('mid-plan prose answer ungrounded');
            this.emit({ kind: 'log', ts: Date.now(), level: 'warn', message: `prose answer rejected (ungrounded: ${ung.join(', ')})` });
            const sp = await getScratchpad(this.taskId);
            await setScratchpad(
              this.taskId,
              `${sp}\n[VERIFICATION] Your answer asserted ${ung.join(', ')}, not found on any page read. Re-read the page (aria.extract) and use only on-page values, or report them as unavailable.`.slice(-12_000),
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
          const g = this.gateFinishSummary(ev.finishVerdict, ev.finishSummary);
          return this.finishOk(hot, g.verdict, g.summary);
        }
        if (next.terminal) {
          const ok = ev.verdict === 'PASS';
          // If the executor wrote the answer as prose on the final step (no finish() call), that
          // text IS the deliverable — gate it like any success rather than discarding it for a
          // generic "Plan complete.".
          const answer = execOut.tool === 'answer' ? (execOut.result.content ?? '').trim() : '';
          if (ok && answer) {
            const g = this.gateFinishSummary('success', answer);
            return this.finishOk(hot, g.verdict, g.summary);
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
          const g = this.gateFinishSummary(ev.finishVerdict, ev.finishSummary);
          return this.finishOk(hot, g.verdict, g.summary);
        }
        if (ev.verdict === 'FAIL' && ev.shouldReplan) {
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
    } catch (err) {
      this.log('error', `Abort cleanup error: ${(err as Error).message}`);
    }
  }

  private async plan(hot: AgentStateHot): Promise<AgentStateHot> {
    hot = await patchHot({ phase: 'PLANNING' });
    this.emit({ kind: 'role.start', ts: Date.now(), role: 'planner' });
    const t0 = performance.now();
    const out = await timed('planner', () =>
      runPlanner({
        ctx: this.commonCtx(hot),
        model: this.opts.settings.plannerModel,
        ollama: this.opts.ollama,
        workflowRecipe: this.matchedWorkflow ? renderRecipe(this.matchedWorkflow) : undefined,
        signal: this.signal,
      }),
    );
    if (out.promptEvalCount && out.evalCount) {
      this.observeTokens(buildPlannerMessages(this.commonCtx(hot)), out.promptEvalCount);
    }
    hot = await this.applyPlan(hot, out.plan);
    this.emit({ kind: 'planner.plan', ts: Date.now(), plan: out.plan });
    this.emit({ kind: 'role.end', ts: Date.now(), role: 'planner', ms: performance.now() - t0 });
    return hot;
  }

  private async replan(hot: AgentStateHot, reason: string): Promise<AgentStateHot> {
    this.markDirty('replan');
    hot = await patchHot({ phase: 'PLANNING', replanCount: hot.replanCount + 1 });
    this.emit({ kind: 'role.start', ts: Date.now(), role: 'planner' });
    const t0 = performance.now();
    const out = await timed('planner.replan', () =>
      runPlanner({
        ctx: this.commonCtx(hot),
        model: this.opts.settings.plannerModel,
        ollama: this.opts.ollama,
        replanContext: reason,
        workflowRecipe: this.matchedWorkflow ? renderRecipe(this.matchedWorkflow) : undefined,
        signal: this.signal,
      }),
    );
    hot = await this.applyPlan(hot, out.plan);
    this.emit({ kind: 'planner.plan', ts: Date.now(), plan: out.plan });
    this.emit({ kind: 'role.end', ts: Date.now(), role: 'planner', ms: performance.now() - t0 });
    this.breaker = resetForNewStep(this.breaker);
    return hot;
  }

  private async executeOne(hot: AgentStateHot, stepId: string): Promise<{
    result: ToolResult;
    tool: string;
  }> {
    hot = await patchHot({ phase: 'EXECUTING', currentStepId: stepId });
    this.emit({ kind: 'role.start', ts: Date.now(), role: 'executor', stepId });
    const t0 = performance.now();

    let scratch = await getScratchpad(this.taskId);
    let ctx = this.commonCtx(hot, scratch);
    const budgetCheck = checkBudget('executor', JSON.stringify(ctx), this.est);
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

    const out = await timed('executor', () =>
      runExecutor({
        ctx,
        model: this.opts.settings.executorModel,
        ollama: this.opts.ollama,
        registry: this.opts.registry,
        toolCtx,
        toolFilter,
        signal: this.signal,
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
      content: redact((out.result.content ?? '').slice(0, 2_000)),
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
    const obsUrl = obs.data && typeof obs.data.url === 'string' ? (obs.data.url as string) : this.lastRead?.url;
    this.lastRead = { tool: 'aria.extract', url: obsUrl, content: obs.content.slice(0, 12_000) };
    this.lastObserveTool = 'aria.extract'; // nudge: act on the fresh page, don't re-extract
    this.recordObserved(obs.content, obsUrl);
    this.emit({
      kind: 'log',
      ts: Date.now(),
      level: 'info',
      message: `auto-read page after navigation${obsUrl ? ` (${obsUrl})` : ''} — ${obs.content.length} chars`,
    });

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
      this.lastRead = { tool: 'aria.extract', url: afterUrl, content: after.content.slice(0, 12_000) };
      this.recordObserved(after.content, afterUrl);
    }
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
      this.lastRead = { tool: out.tool, url, content: (out.result.content ?? '').slice(0, 12_000) };
      this.recordObserved(out.result.content ?? '', url);
    }

    // redact() before persisting: tool args (e.g. tab.type for a job application) can carry the
    // user's email/phone/SSN, and the scratchpad is written to IndexedDB and re-fed into prompts.
    const turnNote = redact(
      `[${new Date().toISOString()}] ${out.tool}(${JSON.stringify(out.args).slice(0, 200)}) -> ${(out.result.content ?? '').slice(0, 800)}`,
    );
    await setScratchpad(this.taskId, `${scratch}\n${turnNote}`.slice(-12_000));

    this.recentActions.push({ tool: out.tool, args: out.args, ok: out.result.ok, content: out.result.content ?? '', ts: Date.now() });
    if (this.recentActions.length > 5) this.recentActions.shift();
    this.trace.push({ tool: out.tool, args: out.args });
  }

  private async evaluate(hot: AgentStateHot, stepId: string, lastResult: string) {
    await patchHot({ phase: 'EVALUATING' });
    const step = hot.plan!.steps.find((s) => s.id === stepId)!;
    // Pass the scratchpad so the evaluator can see data gathered on EARLIER turns — otherwise it
    // judges only the current page and mis-FAILs a step whose data was gathered before the agent
    // moved on (the root of the replan storms).
    const scratch = await getScratchpad(this.taskId);
    this.emit({ kind: 'role.start', ts: Date.now(), role: 'evaluator', stepId });
    const t0 = performance.now();
    const ev = await timed('evaluator', () =>
      runEvaluator({
        ctx: this.commonCtx(hot, scratch),
        model: this.opts.settings.evaluatorModel,
        ollama: this.opts.ollama,
        lastExecutorResult: lastResult,
        step,
        signal: this.signal,
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
      this.observedText,
    );
    if (this.facts.length > before) {
      const f = this.facts[this.facts.length - 1];
      void addFinding({ taskId: this.taskId, kind: 'fact', ts: Date.now(), stepId: step.id, data: f });
    }
  }

  private async compact(hotState: AgentStateHot, scratch: string) {
    await patchHot({ phase: 'COMPACTING' });
    this.emit({ kind: 'role.start', ts: Date.now(), role: 'compactor' });
    const t0 = performance.now();
    const out = await timed('compactor', () =>
      runCompactor({
        goal: hotState.goal,
        toolCatalog: this.opts.registry.describe(),
        scratchpad: scratch,
        model: this.opts.settings.compactorModel,
        ollama: this.opts.ollama,
        signal: this.signal,
      }),
    );
    this.emit({ kind: 'compaction', ts: Date.now(), before: out.charsBefore, after: out.charsAfter });
    this.emit({ kind: 'role.end', ts: Date.now(), role: 'compactor', ms: performance.now() - t0 });
    return out;
  }

  private recordObserved(content: string, url?: string): void {
    if (url && /^https?:\/\//i.test(url)) this.sourceUrls.add(url);
    if (!content) return;
    this.observedText = `${this.observedText}\n${content}`.slice(-60_000);
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
   *  harness's consent auto-dismiss (auto-accepting/rejecting cookies has privacy weight). */
  private canActUrl(url: string | undefined): boolean {
    if (!url || isBlockedUrl(url)) return false;
    return TIER_ORDER[getDomainTier(hostFor(url), this.opts.settings.domainTiers)] >= TIER_ORDER['click-only'];
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
      pageContentBlock: this.lastRead
        ? wrapPageContent(
            `${this.lastRead.tool}${this.lastRead.url ? ` url=${this.lastRead.url}` : ''}`,
            this.lastRead.content,
          )
        : undefined,
      recentActions: this.recentActions
        .map(
          (a) =>
            `- ${a.ok ? '✓' : '✗'} ${a.tool}(${redact(JSON.stringify(a.args).slice(0, 80))}) → ${redact(a.content.slice(0, 200))}`,
        )
        .join('\n'),
      findingsBlock: renderFacts(this.facts),
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

  /** Verify a success answer is grounded in what was actually read.
   *  Deterministic number check only: an e4b LLM verify was tried but false-rejected
   *  correct/honest answers in the benchmark (correct 80%→67%), so it was dropped —
   *  see docs/superpowers/specs/2026-06-18-theme-a-page-grounded-verification-design.md. */
  private verifyFinish(summary: string): { ok: boolean; reason: string } {
    if (!summary || !summary.trim()) {
      return { ok: false, reason: 'no answer text provided' };
    }
    const ungrounded = ungroundedNumbers(summary, groundingCorpus(this.observedText, this.facts));
    if (ungrounded.length) {
      return { ok: false, reason: `value(s) not found on any page read: ${ungrounded.join(', ')}` };
    }
    return { ok: true, reason: '' };
  }

  /** Gate any data-bearing finish (executor OR evaluator) through the deterministic grounding
   *  check. Both roles are the same small-model class and can assert a number that's on no page
   *  read. A 'success' carrying an ungrounded (or empty) answer is downgraded to 'partial'; a
   *  'partial' keeps its verdict but gets the unverified note appended (it's already a concession).
   *  'blocked'/'failed' are honest non-answers with no fabrication risk and pass through unchanged. */
  private gateFinishSummary(verdict: string, summary: string): { verdict: string; summary: string } {
    if (verdict !== 'success' && verdict !== 'partial') return { verdict, summary };
    const v = this.verifyFinish(summary);
    if (v.ok) return { verdict, summary };
    return { verdict: 'partial', summary: `${summary}\n\n[unverified against page: ${v.reason}]` };
  }

  /** Mark this run as "messy" so it won't be distilled into a recipe. Called on any friction —
   *  replan, evaluator FAIL, tier/fatal denial, breaker trip, finish rejection. First reason wins. */
  private markDirty(reason: string): void {
    if (!this.runDirty) {
      this.runDirty = true;
      this.dirtyReason = reason;
    }
  }

  /** Settle the USER recipe (if one drove this run): a CLEAN, non-redundant success proves it
   *  (trust + snapshot); any failure/messy/redundant run quarantines it (rollback to last-good, or
   *  delete if brand-new). Builtin/auto recipes are untouched. This is the user-recipe "catch":
   *  a bad authored recipe can't keep being used. */
  private async settleUserRecipe(verdict: string): Promise<void> {
    const wf = this.matchedWorkflow;
    if (!wf || wf.origin !== 'user') return;
    const cleanSuccess = verdict === 'success' && !this.runDirty && !traceHasRedundancy(this.trace);
    try {
      if (cleanSuccess) {
        await markWorkflowTrusted(wf.id);
        this.emit({ kind: 'log', ts: Date.now(), level: 'info', message: `Recipe "${wf.id}" confirmed (clean run).` });
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
    await this.settleUserRecipe(verdict);
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
    await this.settleUserRecipe('aborted'); // a failed run quarantines the user recipe that drove it
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
      const g = this.gateFinishSummary('partial', answer);
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
        const g = this.gateFinishSummary('partial', salvaged);
        return this.finishOk(hot, g.verdict, g.summary);
      }
    }
    return this.finishOk(hot, fallback.verdict, fallback.summary);
  }

  /** One model call that answers the goal from the observed corpus (everything read this task).
   *  Returns null if nothing meaningful was gathered. The answer is grounding-gated by the caller. */
  private async synthesizeFromObserved(hot: AgentStateHot): Promise<string | null> {
    const corpus = this.observedText.trim();
    if (corpus.length < 40) return null; // nothing was read — nothing to salvage
    try {
      const resp = await this.opts.ollama.chatOnce({
        model: this.opts.settings.executorModel,
        messages: [
          {
            role: 'system',
            content:
              "Answer the user's GOAL using ONLY the notes gathered while browsing (below). State the answer directly and concisely. Use only facts present in the notes — never invent a number or name. If the GOAL is a comparison, use the SAME basis for every item (e.g. each city's primary 'city' population — do NOT mix city and metro-area figures). If the notes don't fully answer the GOAL, give the best partial answer and say what's missing.",
          },
          {
            role: 'user',
            content: `GOAL: ${hot.goal}\n\nGATHERED NOTES (the pages you read this task):\n${corpus.slice(-24_000)}\n\nAnswer the GOAL now from these notes.`,
          },
        ],
        thinking: false,
        numCtx: NUM_CTX,
        timeoutMs: 120_000,
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
    this.opts.emit(ev);
    void appendEvent(this.taskId, ev);
  }

  private assertNotAborted() {
    if (this.signal.aborted) throw new DOMException('Aborted', 'AbortError');
  }

  static async cleanupStaleAndExit(): Promise<void> {
    await clearHot();
  }
}
