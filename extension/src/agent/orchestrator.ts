// Orchestrator: state machine ties everything together.
// IDLE → PLANNING → EXECUTING → EVALUATING → EXECUTING (next step) → ... → DONE | ABORTED.

import type { OllamaClient } from '@/background/ollama';
import type { Plan, Settings, TimelineEvent } from '@/shared/messages';
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
import { runEvaluator } from './roles/evaluator';
import { runCompactor } from './roles/compactor';
import { actionHash, TokenRatioEstimator, ulid } from './util';
import { checkBudget } from './budget';
import {
  type BreakerState,
  checkBreaker,
  newBreakerState,
  recordAction,
  resetForNewStep,
} from './safety/circuit_breaker';
import { currentStep, walkPlan } from './plan';
import { buildPlannerMessages, wrapPageContent } from './prompts';
import { timed } from './metrics';
import { redact, redactDeep } from './safety/redact';
import { sleep } from '@/background/signal';
import { clearSearchResults } from './tools/browser/search';
import { matchWorkflow, renderRecipe, loadWorkflows, saveWorkflow, traceToWorkflow, deriveDomain, type Workflow } from './workflow_memory';
import { renderProfileBlock } from './profile';

// Tools whose output IS page content. The orchestrator carries the most recent
// such result forward into every executor turn (as CURRENT PAGE CONTENT) so that
// synthesis/report turns can actually see the data — the scratchpad only keeps an
// 800-char tail, far too little to list products/prices from.
const READING_TOOLS = new Set(['aria.extract', 'vision.read', 'search']);

// Observation tools (read the page). The executor may not call the SAME one twice
// in a row within a step — it was looping aria.extract instead of acting. Allowing
// the OTHER one preserves the aria→vision fallback.
const OBSERVATION_TOOLS = new Set(['aria.extract', 'vision.read']);

// Actions that (almost) always change the page → the harness auto-re-extracts the
// new page afterward (a small model often fails to re-read and re-uses stale element
// indices, or produces no tool call when forced). tab.type counts only when it submits.
const NAVIGATING_TOOLS = new Set(['tab.click', 'open_result', 'tab.open']);

export interface OrchestratorOpts {
  ollama: OllamaClient;
  registry: ToolRegistry;
  settings: Settings;
  emit: (event: TimelineEvent) => void;
  signal?: AbortSignal;
  maxReplans?: number;
  maxStepTurns?: number;
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
  // Observe-then-act gate: the observation tool used on the previous turn (blocked
  // on the next turn) and the step it applies to (reset when the step changes).
  private lastObserveTool: string | null = null;
  private observeGateStep: string | null = null;
  // Workflow memory: a proven recipe matched to the goal, injected into the planner.
  private matchedWorkflow: Workflow | null = null;
  // The tool sequence executed this run — generalized into a recipe on success (Phase 2).
  private trace: Array<{ tool: string; args: Record<string, unknown> }> = [];

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
    this.lastObserveTool = null;
    this.observeGateStep = null;
    clearSearchResults(); // don't let a prior task's results ground/block this one
    this.trace = [];
    this.matchedWorkflow = matchWorkflow(trimmed, await loadWorkflows());
    this.taskId = ulid();
    const hot = await _setHot(trimmed);
    await setScratchpad(this.taskId, '');
    this.log('info', `Task started: ${trimmed}`);
    if (this.matchedWorkflow) this.log('info', `Workflow recipe matched: ${this.matchedWorkflow.id}`);
    return hot;
  }

  async runUntilTerminal(initial: AgentStateHot): Promise<RunResult> {
    let hot = initial;
    let turn = 0;
    const maxTurns = (this.opts.maxStepTurns ?? 8) * 12;

    hot = await this.plan(hot);

    while (turn < maxTurns) {
      this.assertNotAborted();
      await touchHot();
      const step = currentStep(hot.plan);
      if (!step) {
        return this.finishOk(hot, 'success', 'Plan complete — no remaining steps.');
      }

      const execOut = await this.executeOne(hot, step.id);
      turn += 1;
      hot = await this.refreshHot(hot);

      if (execOut.result.finish) {
        return this.finishOk(hot, execOut.result.finish.verdict, execOut.result.finish.summary);
      }
      if (execOut.result.advanceStep) {
        const ev = await this.evaluate(hot, step.id, execOut.result.content);
        const next = walkPlan(hot.plan!, step.id, ev.verdict === 'PASS' ? 'done' : 'fail');
        hot = await this.applyPlan(hot, next.plan);
        this.breaker = resetForNewStep(this.breaker);
        if (ev.finishVerdict && ev.finishSummary) {
          return this.finishOk(hot, ev.finishVerdict, ev.finishSummary);
        }
        if (next.terminal) {
          const ok = ev.verdict === 'PASS';
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

      const verdict = checkBreaker(this.breaker);
      if (verdict.trip) {
        this.emit({ kind: 'breaker.trip', ts: Date.now(), reason: `${verdict.reason}: ${verdict.detail ?? ''}` });
        if (hot.replanCount >= (this.opts.maxReplans ?? 3) - 1) {
          return this.abortNow(hot, `Circuit breaker tripped (${verdict.reason}) and max replans reached.`);
        }
        hot = await this.replan(hot, `Breaker ${verdict.reason}: ${verdict.detail ?? ''}`);
        continue;
      }

      if (turn % 3 === 0) {
        const ev = await this.evaluate(hot, step.id, execOut.result.content);
        if (ev.finishVerdict && ev.finishSummary) {
          return this.finishOk(hot, ev.finishVerdict, ev.finishSummary);
        }
        if (ev.verdict === 'FAIL' && ev.shouldReplan) {
          if (hot.replanCount >= (this.opts.maxReplans ?? 3) - 1) {
            return this.abortNow(hot, `Evaluator requested replan but max replans reached.`);
          }
          hot = await this.replan(hot, ev.reason);
        }
      }
    }

    return this.abortNow(hot, `Max turns (${maxTurns}) reached.`);
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

    const toolCtx: ToolContext = {
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

    // Auto-observe after navigation: a small model often fails to re-read the new
    // page — it re-uses a stale element index or produces no tool call. After a
    // navigating action the harness re-extracts FOR it, refreshing CURRENT PAGE
    // CONTENT, then marks it observed so the next turn ACTS on the fresh page.
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
    if (navigated && navTabId !== undefined) {
      await sleep(1200); // let the new page begin to load before re-reading
      const obs = await this.opts.registry
        .dispatch('aria.extract', { tabId: navTabId }, toolCtx)
        .catch(() => null);
      if (obs && obs.ok && obs.content) {
        const obsUrl = obs.data && typeof obs.data.url === 'string' ? (obs.data.url as string) : this.lastRead?.url;
        this.lastRead = { tool: 'aria.extract', url: obsUrl, content: obs.content.slice(0, 12_000) };
        this.lastObserveTool = 'aria.extract'; // nudge: act on the fresh page, don't re-extract
      }
    }

    if (out.promptEvalCount && out.evalCount) {
      this.observeTokens(JSON.stringify(ctx), out.promptEvalCount);
    }

    this.emit({ kind: 'tool.call', ts: Date.now(), tool: out.tool, args: out.args });
    this.emit({
      kind: 'tool.result',
      ts: Date.now(),
      tool: out.tool,
      ok: out.result.ok,
      content: redact(out.result.content ?? ''),
    });

    const hash = actionHash(out.tool, out.args);
    const foundFinding =
      out.result.ok &&
      ((out.result.data && Object.keys(out.result.data).length > 0) || (out.result.content?.length ?? 0) > 80);
    this.breaker = recordAction(this.breaker, hash, !!out.result.unknownTool, !!foundFinding);

    // Carry the full page read forward. The scratchpad below keeps only an
    // 800-char tail (fine as a running log), which is nowhere near enough to
    // synthesize a product/price list from on a later turn — so the executor
    // gets the full read back via CURRENT PAGE CONTENT (see commonCtx).
    if (READING_TOOLS.has(out.tool) && out.result.ok && (out.result.content?.length ?? 0) > 0) {
      const data = out.result.data;
      const url = data && typeof data.url === 'string' ? data.url : undefined;
      this.lastRead = { tool: out.tool, url, content: (out.result.content ?? '').slice(0, 12_000) };
    }

    const turnNote = `[${new Date().toISOString()}] ${out.tool}(${JSON.stringify(out.args).slice(0, 200)}) -> ${(out.result.content ?? '').slice(0, 800)}`;
    scratch = `${scratch}\n${turnNote}`.slice(-12_000);
    await setScratchpad(this.taskId, scratch);

    this.recentActions.push({ tool: out.tool, args: out.args, ok: out.result.ok, content: out.result.content ?? '', ts: Date.now() });
    if (this.recentActions.length > 5) this.recentActions.shift();
    this.trace.push({ tool: out.tool, args: out.args });

    this.emit({ kind: 'role.end', ts: Date.now(), role: 'executor', ms: performance.now() - t0 });

    if (out.result.fatal) {
      await sleep(10);
    }

    return { result: out.result, tool: out.tool };
  }

  private async evaluate(hot: AgentStateHot, stepId: string, lastResult: string) {
    await patchHot({ phase: 'EVALUATING' });
    const step = hot.plan!.steps.find((s) => s.id === stepId)!;
    this.emit({ kind: 'role.start', ts: Date.now(), role: 'evaluator', stepId });
    const t0 = performance.now();
    const ev = await timed('evaluator', () =>
      runEvaluator({
        ctx: this.commonCtx(hot),
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

  private commonCtx(hot: AgentStateHot, scratchpad?: string) {
    return {
      goal: hot.goal,
      toolCatalog: this.opts.registry.describe(),
      plan: hot.plan,
      currentStepId: hot.currentStepId,
      ownedTabs: hot.ownedTabs,
      scratchpad,
      profileBlock: renderProfileBlock(this.opts.settings.profileJson),
      pageContentBlock: this.lastRead
        ? wrapPageContent(
            `${this.lastRead.tool}${this.lastRead.url ? ` url=${this.lastRead.url}` : ''}`,
            this.lastRead.content,
          )
        : undefined,
      recentActions: this.recentActions
        .map(
          (a) =>
            `- ${a.ok ? '✓' : '✗'} ${a.tool}(${JSON.stringify(a.args).slice(0, 80)}) → ${redact(a.content.slice(0, 200))}`,
        )
        .join('\n'),
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

  private async finishOk(
    hot: AgentStateHot,
    verdict: string,
    summary: string,
  ): Promise<RunResult> {
    await this.cleanupTabs(hot);
    await patchHot({ phase: 'DONE' });
    // Auto-record: a successful run becomes a reusable recipe (AWM Phase 2).
    if (verdict === 'success') {
      try {
        const wf = traceToWorkflow(`auto:${ulid()}`, hot.goal, deriveDomain(this.trace, hot.goal), this.trace);
        if (wf) await saveWorkflow(wf);
      } catch {
        /* recording is best-effort, never fatal */
      }
    }
    this.emit({ kind: 'finish', ts: Date.now(), verdict, summary });
    return { phase: 'DONE', summary, verdict, turns: this.recentActions.length, replans: hot.replanCount };
  }

  private async abortNow(hot: AgentStateHot, reason: string): Promise<RunResult> {
    await this.cleanupTabs(hot);
    await patchHot({ phase: 'ABORTED' });
    this.emit({ kind: 'finish', ts: Date.now(), verdict: 'aborted', summary: reason });
    return { phase: 'ABORTED', summary: reason, verdict: 'aborted', turns: this.recentActions.length, replans: hot.replanCount };
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
