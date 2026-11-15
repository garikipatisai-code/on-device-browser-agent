# PC Baseline — IMPORTANT Points (Nov 2026)

Source of truth for the on-device browser-agent PC baseline.
Derived from: Gemini reviews + bench runs + code reviews + `docs/plans/pc-baseline-nov26-evidence.json`.

## 1. Baseline hardware (this PC)

- This PC: 30–32 GB RAM (23 GB avail) / NVIDIA Quadro P2200 5 GB / Intel i7-8700 12 threads / 315 GB free disk.
- Minimum bar: **32 GB RAM / 5 GB GPU / 8c CPU / 50 GB free disk**.
- **4 GB profiles out-of-scope short-term.**
- Source: `docs/plans/pc-baseline-nov26-evidence.json` → `baseline.*`, `out_of_scope`.

## 2. Models (hybrid brain/body)

- Brain: `gemma4:e4b-it-q4_K_M` — **6.6 GB**, Tau2 **42.2 quality** signal.
- Body: `gemma4:e2b-it-q4_K_M` — **4.6 GB**, **100% done / 103 s speed** signal.
- Config: **128 K max, 32 K single-window**, `q8` KV + `use_flash_attn`, **loopback-only baseUrl** (constructor-validated), **deterministic gates**.
- Embeds: `mxbai` + `nomic`. Pulls done (`pull_required: true` → pulled).
- Source: evidence.json → `hybrid_config`, `models`; bench logs for sizes/scores.

## 3. Bench to-date (done/correct/grounded)

| Run | done / correct / grounded | Time | Note |
|-----|---------------------------|------|------|
| e4b baseline | 67 / 56 / 67 | — | general baseline |
| e2b | 100 / 33 / 89 | 103 s | speed pick |
| qwen3.5:4b | 33 / 33 / 89 | 259 s | slower, worse done-rate |
| e2b-q4 full (5 tasks) | totals missing | **1270 s, EXIT:0** | reporter capture bug (see §6) |
| e4b-q4 full | running | — | pending totals re-run |

- Fit: **E2B fits 5 GB full-GPU; E4B needs split** (unload-then-load / keep_alive:0 rotation in `run.bench.test.ts`).
- QAT option: **98.5% fidelity** drop-in if Q4 quality gates fail.
- Source: evidence.json → `prior_bench`; bench stdout logs.

## 4. Runtimes

- **Ollama = default** runtime.
- **llama-server unlocks 1 M ctx / YaRN / draft / GBNF**; hybrid seam via `ModelProvider`.
- **Speculative decode blocked on Ollama #5800** — do not plan around it on Ollama path.
- **Nano excluded (16 GB req).**
- **FreeToken = MoE serving, not dense** — do not compare as dense-perf.
- Source: Gemini runtime review + `ModelProvider` seam.

## 5. Debts / triage (accepted)

- **28 dirty files triaged**: ours keep, pre-existing defer, stray deleted.
- **DNS-rebind accepted** (no DNS API available to do better).
- **throw-split + per-role ctx deferred.**
- **SettingsPanel drift deferred.**
- Source: code-review threads; evidence.json → `debts`.

## 6. Next needful — bench totals capture (reporter fix, no src change)

Root cause (read-only finding, 2026-11-14):

- Totals are built in `extension/tests/bench/report.ts:67` as lowercase:
  `── totals over ${a.total} runs ──` + completed/correct/grounded + mean turns/time/tokens.
- They are emitted only via `console.log(formatReport(...))` in
  `extension/tests/bench/run.bench.test.ts:165` (`log = (s) => console.log(s)`).
- Vitest's default (dot) reporter buffers/hides `console.log` on long runs, and a
  case-sensitive `grep -n "Totals over"` **misses** (code is lowercase `totals over`).
  That is why the e2b-q4 1270 s EXIT:0 run shows per-task `[bench]` lines but no totals.

How to capture without touching src (approved):

```bash
# verbose keeps console.log in stdout; tee preserves it past TUI scrollback
npm run bench -- --reporter=verbose 2>&1 | tee bench-e2b-q4.log
grep -in "totals over" bench-e2b-q4.log
grep -n "bench]" bench-e2b-q4.log | tail -20
```

- Use `-i` (or lowercase `totals over`): `grep -n "Totals over"` returns nothing by design.
- Alternative: `--reporter=json --outputFile=bench.json` for machine capture.
- Durable fix (deferred, needs src edit — NOT done here): also `writeFileSync`
  `formatReport` output to `bench-<model>.log` next to the `console.log`.
- Then: **re-run e2b/e4b Q4 with totals, lock evidence** into
  `docs/plans/pc-baseline-nov26-evidence.json`.

## 7. Q4 totals + lock (2026-11-14, BRAIN-only)

| Run | done / correct / grounded | Time | Tokens | Suite | Note |
|-----|---------------------------|------|--------|-------|------|
| e2b-q4 | 33 / 33 / 89 | 262 s | 12185 tok | 2362 s | body candidate |
| e4b-q4 | 67 / 56 / 78 | 260 s | 18961 tok | 2344 s | **pick (brain)** — RSS 435 MB, 100% GPU, ctx 32768 |
| e4b baseline (prior) | 67 / 56 / 67 | — | — | — | general baseline |
| e2b (prior) | 100 / 33 / 89 | 103 s | — | — | speed pick |
| qwen3:4b (prior) | 33 / 33 / 89 | 259 s | — | — | slower, worse done-rate |

- Pick: **e4b-q4 (brain)** — 56% correct vs 33%, 67% done vs 33%, same time, fits via 435 MB resident.
- Hybrid stays: **brain e4b-q4 + body e2b-q4**, single 32K window.
- Source: ses_e2424d11fffe3bdKkh3tQrwOXN.

## 8. Model prune (2026-11-14, user-approved, BRAIN-only)

- Pruned (7 tags, ~68 GB freed): `gemma4:12b` (7.6 GB), `gemma4:e4b` (9.6 GB),
  `gemma4:26b` (17 GB), `gemma4:e2b` (7.2 GB), `qwen3.6:35b-a3b` (23 GB),
  `qwen3.5:4b` (3.4 GB), `nomic-embed-text:latest` (274 MB) — all `ollama rm` RM:0.
- Kept (PC-baseline only, `ollama list` verified): `gemma4:e4b-it-q4_K_M` (6.6 GB, brain),
  `gemma4:e2b-it-q4_K_M` (4.6 GB, body), `mxbai-embed-large:latest` (669 MB, embeddingModel).
- Disk after: `/dev/sda4 471G 133G 314G 30% /`.
- Note: `nomic-embed-text` removed; `mxbai-embed-large` is the default embeddingModel. §2 mention of `nomic` is superseded.

## 9. Quality no-perf-loss lock (2026-11-14, BRAIN-only docs)

- Status: **locked**. Plan `docs/plans/quality-no-perf-loss.md`; ledger
  `docs/plans/quality-no-perf-loss-progress.md`; evidence
  `docs/plans/quality-no-perf-loss-evidence.json`.
- Tasks (all passed, fast path **zero extra LLM calls**):
  - T1 finish gate fail-closed — **6 passed**.
  - T2 number+entity grounding — **14 passed**.
  - T3 think-routing (retry fix) — **18 passed**.
  - T4 hybrid stub — **72 passed**.
  - T5 loop guards — **13 passed**.
- Final gate: **TYPE 0 / LINT 0 / TEST 0 — 765 passed / 1 file**.
- Properties: **fail-closed**, **single-source quick-chat**, per-role already locked.

## 10. Quality T6–T10 lock (2026-11-15, BRAIN-only docs)

- Status: **locked**. Evidence `docs/plans/quality-no-perf-loss-evidence.json`
  (gate 866); ledger `docs/plans/quality-no-perf-loss-progress.md`.
- Tasks (all passed, fast path **zero extra LLM rounds**):
  - T6 DAG 4 passed — parse + join + deterministic dispatch gates 2/2.
  - T7 probe 14 passed (NaN fix) — gates 2/2.
  - T8 bank 63 passed — gates 2/2.
  - T9 flat 12 passed (R@5 fix) — gates 2/2.
  - T10 fusion 12 passed — gates 2/2.
- Final gate: **TYPE 0 / LINT 0 / TEST 0 — 866 passed / 1 file**.
- Properties: **fail-closed**, **single-source quick-chat**, RRF-60, MRL-256,
  cascade, anchored compact, probes.
