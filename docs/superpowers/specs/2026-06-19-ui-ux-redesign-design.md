# UI/UX Redesign — On-Device Browser Agent (side panel)

**Date:** 2026-06-19 · **Branch:** `feat/ui-ux-redesign`

**Goal:** Turn the side panel from a utilitarian *debug log* into a calm, trustworthy, best-in-class **agent-watching → answer** experience — without adding dependencies, changing any SW/port message contract, or breaking the green suite.

## Why (the core insight)

The agent's job is: take a goal → work for *minutes* (e4b is ~20–30s/turn) → produce an **answer**. Today the UI:
- buries the answer as one line in a raw event log (`role.start`, `tool.call` + JSON, emoji);
- shows the plan only as a `2/4` counter;
- shows phase as a raw enum (`EXECUTING`);
- gives no reassurance during the long waits;
- is plain (flat borders, generic blue, emoji icons, no brand, no motion).

A world-class agent UX must **(1) hero the answer, (2) make the plan a live checklist, (3) narrate liveness in human language with calm motion, (4) demote the raw log to an opt-in "Activity" stream, (5) carry a crafted, privacy-forward brand.**

## Principles
- **Local & private is the brand.** A persistent "Local · Private" pill; nothing leaves the device. Calm, trustworthy, intelligent.
- **Zero new runtime deps.** Hand-authored CSS design system + inline SVG icons. No Tailwind/MUI/icon-lib (matches the project's no-bloat ethos).
- **Contracts frozen.** All `send({...})` commands and the `onUpdate` `SwUpdate` switch stay byte-identical. This is presentation + interaction only; data flow unchanged.
- **Narrow canvas.** Single column, ~360–420px. Everything designed for that width.
- **Accessible & motion-safe.** ARIA tabs, focus-visible, contrast ≥ WCAG AA, `prefers-reduced-motion` honored.

## Design system (tokens → `styles.css`, rewritten)
- **Color — one confident accent (indigo/violet) + semantic.** Light: `--bg #ffffff`, `--surface #f7f8fc`, `--surface-2 #eef0f7`, `--fg #181b26`, `--fg-mute #5c6478`, `--border #e4e7f0`, `--accent #5b5bd6`, `--accent-weak rgba(91,91,214,.1)`, `--ok #1f9d57`, `--warn #d18b00`, `--danger #d6453d`. Dark: `--bg #0e1016`, `--surface #161922`, `--surface-2 #1e2230`, `--fg #e8eaf2`, `--fg-mute #8b94a8`, `--border #262b3a`, `--accent #8a8af2`, `--ok #4cce84`, `--warn #f0b53d`, `--danger #ff6b62`.
- **Type:** system stack (no web-font fetch). Scale: 11 / 12 / 13(base) / 15 / 18 / 24. Weights 400/500/600/700. Headings tighter line-height.
- **Space:** 4px rhythm — 4/8/12/16/20/24. **Radius:** 12 (cards) / 8 (controls) / 999 (pills). **Elevation:** `--shadow` subtle in light, border-only in dark.
- **Motion (CSS keyframes, all gated by `prefers-reduced-motion`):** `pulse` (working indicator), `shimmer` (active step bar), `rise` (card/event fade-slide-in), `pop` (step-complete check). ~140–220ms ease-out.
- **Icons:** one inline-SVG component `Icon` with a small set: `spark` (brand), `run`, `stop`, `check`, `dot`, `spinner`, `plan`, `globe`, `cursor`, `search`, `eye`, `flag`, `alert`, `gear`, `gauge`, `copy`, `lock`. Replaces all emoji.

## Information architecture
Top nav restyled as accessible **icon+label tabs** (Agent / Settings / Metrics), crisp active state. Header above tabs: brand mark + "Browser Agent" wordmark + "Local · Private" lock pill.

### Agent tab (the hero) — vertical order
1. **Composer.** One primary goal textarea (auto-grows 1→3 lines) + a `Run` button (becomes `Stop`, danger, while running). A secondary **"Apply to a job"** disclosure toggle that swaps the composer to a URL field (so the two inputs no longer compete). First-run: 3 example chips that fill the goal.
2. **Notices.** Inline alerts (preflight fail / errors) with an icon + remediation text (e.g. "Ollama unreachable — start `ollama serve`").
3. **Run state** *(while running, or last run)*: a card with the **friendly phase** (`PhasePill`: PLANNING→"Planning the task", EXECUTING→"Working in the page", EVALUATING→"Checking the result", COMPACTING→"Summarizing context", + animated indicator) + **elapsed timer** + **plan checklist** (each `status.plan.steps` row: ✓ completed / animated ◌ active / ○ pending / ✗ failed, active step emphasized).
4. **Result card** *(phase DONE/ABORTED, from the last `finish` event)*: **hero the answer** — a verdict badge (Success/Partial/Blocked/Failed with tone+icon), the summary rendered readably, a **Copy** button, and a meta line (`N steps · Ys · M replans`).
5. **Activity** *(collapsible, default collapsed once a result exists; open while running)*: the redesigned timeline — clean event rows grouped under their step, human titles, tool args collapsed behind a "details" toggle, the auto-read log shown as a calm sub-line. Power-user transparency without dominating.
6. **Empty state:** calm branded panel — "State a goal and I'll handle the browsing. Everything runs on your machine." + the example chips.

### Settings tab — grouped cards (not one long scroll)
- **Connection:** Ollama base URL + a live status dot (reachable/not).
- **Models:** the 6 model fields, each with an "installed ✓ / not pulled ⚠" chip; the datalist + refresh.
- **Profile:** résumé upload + JSON textarea (unchanged logic, restyled).
- **Domain access:** tier rows + add, with tier explained.
- Sticky **Save** affordance.

### Metrics tab
Refined latency table inside a card + a one-line summary (ops count, slowest op). Keep it lightweight.

## Component architecture (refactor `App.tsx`; contracts unchanged)
`App.tsx` stays the state/port owner (the `useEffect` connect, `onUpdate` switch, `send`). Extract focused, single-purpose components:
- `components/Brand.tsx` — mark + wordmark + privacy pill.
- `components/Icon.tsx` — inline-SVG set (pure, prop `name`).
- `components/Tabs.tsx` — ARIA tablist.
- `components/Composer.tsx` — goal/apply modes + Run/Stop + example chips.
- `components/RunState.tsx` — PhasePill + elapsed + plan checklist.
- `components/ResultCard.tsx` — verdict hero + summary + copy + meta.
- `components/Timeline.tsx` — restyled activity stream (rewrite).
- `components/Alert.tsx` — notices.
- `components/SettingsPanel.tsx`, `components/MetricsPanel.tsx` — restyle.
- **Pure view-model helpers (unit-tested — this is where logic + TDD live):**
  - `view/phase.ts` — `describePhase(phase): {label, tone, busy}` and `isRunning(phase)`.
  - `view/format.ts` — `formatElapsed(ms)`, `formatVerdict(verdict): {label, tone}`.
  - `view/result.ts` — `latestFinish(events): {verdict, summary} | null`, `planProgress(plan)`.

## States to cover
Idle/empty · first-run (chips) · preflight-failing (Ollama down / missing models) · planning · executing (with live plan) · evaluating · done-success · done-partial · blocked/failed · aborted · running-then-panel-reconnect (timeline resync). Each has an explicit visual.

## Testing & verification
- Unit-test the pure `view/*` helpers (RED→GREEN): phase descriptions for every `TaskPhase`, elapsed/verdict formatting, `latestFinish`/`planProgress` over event/plan fixtures.
- No React-Testing-Library setup is added (repo has none); components stay thin over tested helpers.
- After each step: full vitest suite + `tsc` + `vite build` must stay green. The redesign must not touch the 317 existing passing tests' behavior.

## Out of scope (YAGNI)
New product name/rebrand beyond a wordmark+mark; theme switcher (rely on `prefers-color-scheme`); animation libraries; settings redesign beyond grouping; i18n.
