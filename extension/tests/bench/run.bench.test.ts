// @vitest-environment node
//
// Live task-success benchmark. Runs the REAL orchestrator loop against the REAL
// local model over scripted fixtures. Gated: only runs under `npm run bench`
// (OLLAMA_BENCH=1). The dev sandbox cannot reach Ollama — the user runs this.
//
// Each trial streams its result the moment it finishes (verdict + flags + the
// answer text), and is capped by a per-task wall-clock budget so one runaway loop
// can't eat the whole run. A timeout therefore never discards prior results.
//
//   npm run bench                                   # 5 tasks × 1 trial, gemma4:e4b
//   OLLAMA_BENCH_TASK=shop-detail npm run bench     # one task only (fast ~90s sanity check)
//   OLLAMA_BENCH_TRIALS=3 npm run bench             # more trials → stabler rates
//   OLLAMA_BENCH_MODEL=gemma4:12b npm run bench     # different model
//   OLLAMA_BENCH_TASK_TIMEOUT_MS=180000 npm run bench   # raise the per-task cap

import { describe, it, expect } from 'vitest';
import { Orchestrator } from '@/agent/orchestrator';
import { OllamaClient } from '@/background/ollama';
import { DEFAULT_SETTINGS } from '@/shared/messages';
import { clearHot } from '@/background/state_store';
import { resetStorage } from '../helpers';
import { BENCH_TASKS, type BenchTask } from './fixtures';
import { ScriptedBrowser, buildScriptedRegistry } from './scripted_browser';
import { scoreRun, type BenchRun, type Score } from './scorer';
import { formatReport, type TaskResult } from './report';

const RUN = !!process.env.OLLAMA_BENCH;
const MODEL = process.env.OLLAMA_BENCH_MODEL || 'gemma4:e4b';
const TRIALS = Number.parseInt(process.env.OLLAMA_BENCH_TRIALS || '1', 10);
const BASE = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const TASK_TIMEOUT_MS = Number.parseInt(process.env.OLLAMA_BENCH_TASK_TIMEOUT_MS || '150000', 10);
const ONLY = process.env.OLLAMA_BENCH_TASK || ''; // run a single task id if set

const TASKS = ONLY ? BENCH_TASKS.filter((t) => t.id === ONLY) : BENCH_TASKS;
// Bounded by the per-task cap, so the suite can never run away. + margin for setup.
const VITEST_TIMEOUT = TASKS.length * TRIALS * (TASK_TIMEOUT_MS + 10_000) + 60_000;

async function runTrial(task: BenchTask): Promise<{ run: BenchRun; score: Score; ms: number }> {
  await resetStorage();  // seed-only workflow memory each trial → independence
  await clearHot();

  const ollama = new OllamaClient(BASE);
  const state = new ScriptedBrowser(task);
  const registry = buildScriptedRegistry(state);
  const settings = {
    ...DEFAULT_SETTINGS,
    plannerModel: MODEL, executorModel: MODEL, evaluatorModel: MODEL,
    compactorModel: MODEL, visionModel: MODEL,
    profileJson: task.profileJson ?? '',
  };

  const ac = new AbortController();
  let toolCalls = 0; // count real tool.call events (orchestrator's result.turns caps at 5)
  const orch = new Orchestrator({
    ollama, registry, settings,
    emit: (e) => { if (e.kind === 'tool.call') toolCalls += 1; },
    signal: ac.signal,
  });

  const t0 = Date.now();
  let phase: 'DONE' | 'ABORTED' = 'ABORTED';
  let verdict = 'aborted';
  let summary = '';
  const timer = setTimeout(() => ac.abort(new Error('bench per-task timeout')), TASK_TIMEOUT_MS);
  try {
    const initial = await orch.start(task.goal);
    const result = await orch.runUntilTerminal(initial);
    phase = result.phase;
    verdict = result.verdict;
    summary = result.summary;
  } catch (err) {
    summary = `ERROR: ${(err as Error).message}`;
    verdict = ac.signal.aborted ? 'timeout' : 'error';
  } finally {
    clearTimeout(timer);
  }

  const run: BenchRun = {
    phase, verdict, summary,
    // Grounding corpus = the user's GOAL + everything observed (pages/search) +
    // the profile. A number the user themselves provided (e.g. a product name's
    // "9000") is legitimate knowledge, not a hallucination.
    observedText: `${task.goal}\n${state.observedText()}`,
    turns: toolCalls, replans: 0,
  };
  return { run, score: scoreRun(task.expect, run), ms: Date.now() - t0 };
}

describe.skipIf(!RUN)('task-success benchmark (live model)', () => {
  it(
    `runs ${TASKS.length} task(s) × ${TRIALS} trial(s) on ${MODEL}`,
    async () => {
      const ollama = new OllamaClient(BASE);
      expect(await ollama.ping(), `Ollama unreachable at ${BASE} — is "ollama serve" running?`).toBe(true);

      // eslint-disable-next-line no-console
      const log = (s: string) => console.log(s);
      log(`\n[bench] ${TASKS.length} task(s) × ${TRIALS} trial(s) · model=${MODEL} · per-task cap=${(TASK_TIMEOUT_MS / 1000).toFixed(0)}s\n`);

      const results: TaskResult[] = [];
      for (const task of TASKS) {
        const scores: Score[] = [];
        const turns: number[] = [];
        for (let i = 0; i < TRIALS; i++) {
          const { run, score, ms } = await runTrial(task);
          scores.push(score);
          turns.push(run.turns);
          // Stream the result NOW so a later timeout never discards it.
          const flag = (ok: boolean) => (ok ? '✓' : '✗');
          log(
            `[bench] ${task.id.padEnd(14)} ${i + 1}/${TRIALS}  ${(ms / 1000).toFixed(0).padStart(3)}s ${String(run.turns).padStart(2)}t  ` +
            `verdict=${run.verdict.padEnd(8)} ${flag(score.completed)}done ${flag(score.correct)}correct ${flag(score.grounded)}grounded`,
          );
          log(`        answer: ${run.summary.replace(/\s+/g, ' ').trim().slice(0, 220)}`);
          if (score.reasons.length) log(`        ↳ ${score.reasons[0]}`);
        }
        results.push({ id: task.id, scores, turns });
      }

      log(formatReport(results, { model: MODEL, trials: TRIALS }));
      expect(results.length).toBe(TASKS.length);
    },
    VITEST_TIMEOUT,
  );
});
