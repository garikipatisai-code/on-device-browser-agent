// @vitest-environment node
//
// Live task-success benchmark. Runs the REAL orchestrator loop against the REAL
// local model over scripted fixtures. Gated: only runs under `npm run bench`
// (OLLAMA_BENCH=1). The dev sandbox cannot reach Ollama — the user runs this.
//
//   npm run bench
//   OLLAMA_BENCH_MODEL=gemma4:e4b OLLAMA_BENCH_TRIALS=3 npm run bench

import { describe, it, expect } from 'vitest';
import { Orchestrator } from '@/agent/orchestrator';
import { OllamaClient } from '@/background/ollama';
import { DEFAULT_SETTINGS } from '@/shared/messages';
import { clearHot } from '@/background/state_store';
import { resetStorage } from '../helpers';
import { BENCH_TASKS } from './fixtures';
import { ScriptedBrowser, buildScriptedRegistry } from './scripted_browser';
import { scoreRun, type BenchRun, type Score } from './scorer';
import { formatReport, type TaskResult } from './report';

const RUN = !!process.env.OLLAMA_BENCH;
const MODEL = process.env.OLLAMA_BENCH_MODEL || 'gemma4:e4b';
const TRIALS = Number.parseInt(process.env.OLLAMA_BENCH_TRIALS || '3', 10);
const BASE = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

describe.skipIf(!RUN)('task-success benchmark (live model)', () => {
  it(
    `runs ${BENCH_TASKS.length} tasks × ${TRIALS} trials on ${MODEL}`,
    async () => {
      const ollama = new OllamaClient(BASE);
      expect(await ollama.ping(), `Ollama unreachable at ${BASE} — is "ollama serve" running?`).toBe(true);

      const results: TaskResult[] = [];

      for (const task of BENCH_TASKS) {
        const scores: Score[] = [];
        const turns: number[] = [];

        for (let i = 0; i < TRIALS; i++) {
          await resetStorage();        // seed-only workflow memory each trial → independence
          await clearHot();

          const state = new ScriptedBrowser(task);
          const registry = buildScriptedRegistry(state);
          const settings = {
            ...DEFAULT_SETTINGS,
            plannerModel: MODEL, executorModel: MODEL, evaluatorModel: MODEL,
            compactorModel: MODEL, visionModel: MODEL,
            profileJson: task.profileJson ?? '',
          };

          const orch = new Orchestrator({ ollama, registry, settings, emit: () => undefined });
          let phase: 'DONE' | 'ABORTED' = 'ABORTED';
          let verdict = 'aborted';
          let summary = '';
          try {
            const initial = await orch.start(task.goal);
            const result = await orch.runUntilTerminal(initial);
            phase = result.phase;
            verdict = result.verdict;
            summary = result.summary;
            turns.push(result.turns);
          } catch (err) {
            summary = `ERROR: ${(err as Error).message}`;
          }

          const run: BenchRun = {
            phase, verdict, summary,
            observedText: `${state.observedText()}\n${task.profileJson ?? ''}`,
            turns: turns[turns.length - 1] ?? 0,
            replans: 0,
          };
          scores.push(scoreRun(task.expect, run));
        }

        results.push({ id: task.id, scores, turns });
      }

      // eslint-disable-next-line no-console
      console.log(formatReport(results, { model: MODEL, trials: TRIALS }));

      // Soft gate: the suite passes as long as it ran. The NUMBERS are the output;
      // we do not fail CI on a low score (this file never runs in CI anyway).
      expect(results.length).toBe(BENCH_TASKS.length);
    },
    20 * 60_000, // up to 20 min for the full matrix on a small local model
  );
});
