---
spec: docs/architecture-map.md
status: approved
approved_by: human
approved_at: 2026-11-14
files: [docs/plans/pc-baseline-nov26.md]
allow: [docs/plans/pc-baseline-nov26-progress.md]
---

# PC Baseline Nov 2026

> **For agentic workers:** This is a documentation/scribe plan. No `extension/src/` files are touched; only `docs/plans/pc-baseline-nov26.md` and `docs/plans/pc-baseline-nov26-progress.md` may be created or edited.

**Goal:** Establish a repeatable, read-only PC (desktop) baseline for the on-device-browser-agent Chrome MV3 extension as of November 2026. Capture the current settings shape, per-role context budgets, page-tool inventory and gating, safety enforcement defaults, and key performance characteristics as a fixed reference, so future changes can be diffed against it. The baseline observes current behavior only; it does not change any `extension/src/` behavior.

**Architecture:** Read-only observation layer. A baseline run enumerates (a) `Settings`/`DEFAULT_SETTINGS` keys from `extension/src/shared/messages.ts`, (b) per-role budgets/context from `extension/src/agent/budget.ts`, (c) the page-tool catalog and domain-tier gating from `extension/src/agent/tools/browser/page.ts` and `extension/src/agent/safety/domain_tiers.ts`, and (d) Ollama call shape/timeouts from `extension/src/background/ollama.ts`. Observations are recorded in this plan and the progress ledger; nothing in `extension/src/` is modified.

**Tech Stack:** TypeScript, Vitest (existing tests run read-only), `extension/src/shared/messages.ts` (Settings/`DEFAULT_SETTINGS`), `extension/src/agent/budget.ts`, `extension/src/agent/safety/*.ts`, `extension/src/agent/tools/browser/page.ts`, `extension/src/background/ollama.ts`, `docs/architecture-map.md` as the spec reference.

Spec: `docs/architecture-map.md` (component map §, goal's journey §, model tiering §, tool layer & page-level tools §, agent/safety §)

**Constraints:**
- No `extension/src/` edits or additions — out of scope. Only the two `docs/plans/` files may be created or edited.
- Baseline records current behavior as-is; no normalization to desired behavior.
- No secrets in baseline artifacts: omit/redact API keys, credentials, and URLs containing tokens or PII.
- Baseline must be deterministic and re-runnable against the same extension build.

**Review Focus:**
- Characterization asserts *current* behavior, not *desired* behavior (no new expectations introduced).
- Each task's verify command runs without modifying src.
- Confirm no API keys or credential-bearing URLs appear in any baseline artifact.
- Confirm frontmatter `status: draft` with empty `approved_by`/`approved_at` until human review.

---

### Task 1: Goal & scope lock

**Files:**
- `docs/plans/pc-baseline-nov26.md` (Goal + Constraints sections)

**Verify:**
- `grep -n "Goal:" docs/plans/pc-baseline-nov26.md` → Goal section present.
- `grep -n "out.of.scope\|Out.of.scope\|no.*src.*edit" docs/plans/pc-baseline-nov26.md` → out-of-scope boundary stated.

Depends on: nothing.

### Task 2: Architecture & spec mapping

**Files:**
- `docs/plans/pc-baseline-nov26.md` (Architecture + Spec sections)

**Verify:**
- `grep -n "docs/architecture-map.md" docs/plans/pc-baseline-nov26.md` → Spec references the architecture map.
- Confirm Architecture enumerates the observed component files (messages.ts, budget.ts, page.ts, domain_tiers.ts, ollama.ts).

Depends on: Task 1.

### Task 3: Tech stack & constraints inventory

**Files:**
- `docs/plans/pc-baseline-nov26.md` (Tech Stack + Constraints sections)

**Verify:**
- `grep -n "no.*src\|No.*src\|no secrets\|No secrets" docs/plans/pc-baseline-nov26.md` → no-src-edits and no-secrets constraints present.

Depends on: Task 2.

### Task 4: Review focus & acceptance criteria

**Files:**
- `docs/plans/pc-baseline-nov26.md` (Review Focus section)

**Verify:**
- `grep -n "Review Focus" docs/plans/pc-baseline-nov26.md` → Review Focus present.
- Confirm acceptance bullets: current-behavior-only, no src modification, no secrets.

Depends on: Task 3.

### Task 5: Coverage checklist & progress ledger (T0)

**Files:**
- `docs/plans/pc-baseline-nov26.md` (Coverage checklist)
- `docs/plans/pc-baseline-nov26-progress.md` (new progress ledger)

**Verify:**
- `ls -l docs/plans/pc-baseline-nov26.md docs/plans/pc-baseline-nov26-progress.md; echo EXIT:$?` → both files exist, EXIT:0.
- `sha256sum docs/plans/pc-baseline-nov26.md` → recorded.
- Progress ledger shows T0 done.

Depends on: Task 4.

---

## Hardware baseline (32GB+ RAM, 5GB+ GPU)

- RAM: 30-32GB total (23GB available); baseline requires 32GB+ RAM.
- GPU: NVIDIA Quadro P2200 5GB; baseline requires 5GB+ GPU.
- CPU: Intel i7-8700, 12 threads; baseline requires 8c+.
- Disk: 315GB free; baseline requires 50GB free for models.
- Runtime: Ollama + models installed.
- Models: e2b-q4 4.6GB + e4b-q4 6.6GB (pull required), mxbai/nomic embeds.
- Hybrid config: brain `gemma4:e4b-it-q4_K_M` + body `gemma4:e2b-it-q4_K_M`, 32K single window, q8 KV + flash-attn, loopback-only baseUrl, deterministic gates.
- Out of scope: 4GB profiles.

## Coverage checklist

- [ ] `docs/plans/pc-baseline-nov26.md` exists with frontmatter `status: draft`, empty `approved_by`/`approved_at`.
- [ ] Goal, Architecture, Tech Stack, Spec, Constraints, Review Focus sections present.
- [ ] Tasks 1–5 each have Files and Verify.
- [ ] No `extension/src/` file is referenced for modification.
- [ ] No secrets (API keys, credential URLs) in baseline artifacts.
- [ ] `docs/plans/pc-baseline-nov26-progress.md` exists with T0 marked done.
- [ ] Plan sha256 and byte count recorded after creation.
