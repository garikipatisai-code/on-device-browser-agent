# Run progress meter — design

## Motivation

While a task runs, the side panel's only progress signals are a pulsing phase dot (which role is active) and a wall-clock elapsed timer (how long it's been running) — neither says how much of the plan is actually done. The user reported having "no way to look at progress" while a run is in flight and asked for something that represents *actual* progress, not an indeterminate animation.

## Scope

In scope — confined to `extension/src/sidepanel/components/RunState.tsx`, `extension/src/sidepanel/styles.css`, and `extension/tests/unit/components_render.test.tsx`:
- A visual progress bar inside the existing `RunState` card, driven by plan-step completion.

Out of scope:
- Any change to the Agent tab button, app header, or any other tab (confirmed with the user — the meter lives only in the existing status card, matching where progress is already surfaced today).
- Any orchestrator, message-shape, or backend change. `planProgress(plan)` (`sidepanel/view/result.ts`) already computes `{total, done, activeIndex}` from the `Plan` the component already receives as a prop — this data has existed, unit-tested, since before this feature; it was simply never rendered. No new data flows.
- A sub-step progress estimate (e.g. turns-taken-on-this-step vs. an expected count). Rejected during design: it would require new tracking with no natural ground truth for "expected" turns, for a benefit (finer-grained motion within one step) the pulsing leading-edge dot already delivers more cheaply and more honestly.
- A turn-count-based bar (`turn / maxTurns`). Rejected: `maxTurns` (~96) is a hard safety ceiling almost no real task approaches, so this ratio would sit near zero for most of a task's real duration — it would misrepresent progress rather than represent it.

## Design

### Data

`RunState` already receives `plan: Plan | null` as a prop. It computes `const progress = planProgress(plan);` (import from `../view/result`, already exported, already unit-tested in `tests/unit/view_helpers.test.ts`). `progress.done` counts only `status === 'completed'` steps (not `failed`) — this is the existing helper's established convention; the meter does not introduce a different counting rule.

The meter block renders only when `progress.total > 0`. Before a plan exists (`PLANNING` phase), there is nothing to show a fraction of — the existing phase-dot pulse already covers "something is happening" for that window.

### Markup (in `RunState`, between the `.phase` row and the `.plan` checklist)

```tsx
{progress.total > 0 && (
  <div
    className="progress-meter"
    role="progressbar"
    aria-valuemin={0}
    aria-valuemax={progress.total}
    aria-valuenow={progress.done}
    aria-valuetext={`${progress.done} of ${progress.total} steps complete`}
  >
    <div className="progress-track">
      <div className="progress-fill" style={{ width: `${(progress.done / progress.total) * 100}%` }}>
        {progress.activeIndex !== -1 && <span className="progress-fill-pulse" />}
      </div>
    </div>
    <span className="progress-label">{progress.done} of {progress.total} steps</span>
  </div>
)}
```

The pulse dot is a child of `.progress-fill` (so it sits exactly at the fill's right edge regardless of width) and only renders while some step is `active` — i.e. it disappears the instant every step is resolved (completed or failed), which in practice is right before the run's terminal `finish` event arrives. This makes the "until final message received" requirement fall out of existing render-gating (`RunState` itself stops rendering once `running` goes false in `App.tsx`) rather than needing new logic.

### CSS

```css
.progress-meter { display: flex; align-items: center; gap: var(--sp-2); }
.progress-track { flex: 1; height: 6px; border-radius: var(--r-pill); background: var(--surface-2); }
.progress-fill { position: relative; height: 100%; border-radius: var(--r-pill); background: var(--accent); transition: width 300ms ease; }
.progress-fill-pulse {
  position: absolute; right: -3px; top: 50%; transform: translateY(-50%);
  width: 6px; height: 6px; border-radius: 50%; background: var(--accent);
  animation: pulse 1.4s ease-in-out infinite;
}
.progress-label { flex: none; font-size: 11.5px; color: var(--fg-mute); font-variant-numeric: tabular-nums; }
```

`.progress-track` deliberately has no `overflow: hidden`: `.progress-track` and `.progress-fill` share the same height (6px) and the same `border-radius: var(--r-pill)` (999px, i.e. fully rounded for any box that short), so a shorter capsule left-aligned inside a longer capsule of identical height already renders with correct rounded ends at any width, with no clipping needed — and no clipping means the pulse dot at `right: -3px` (deliberately half-overlapping the fill's edge, marking the frontier of progress) is never cut off. Reuses the existing `pulse` keyframe (already defined for `.phase-dot`) and the existing global `@media (prefers-reduced-motion: reduce)` rule (`*, *::before, *::after { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; }`) automatically covers both the fill's width transition and the pulse animation — no new reduced-motion CSS needed.

### Accessibility

`role="progressbar"` + `aria-valuemin`/`aria-valuemax`/`aria-valuenow` give assistive tech the numeric fraction; `aria-valuetext` gives the same "N of M steps complete" phrasing a sighted user reads in `.progress-label`, so both experiences carry the same information.

### Testing

Extends `components_render.test.tsx`'s existing `'RunState renders the human phase label + every plan step'` coverage (it already renders `RunState` with a 3-step mixed-status plan fixture: one completed, one active, one pending):
- That existing fixture's render should now also show `1 of 3 steps` and an `aria-valuenow="1"`.
- A new case with `plan={null}`: no `role="progressbar"` in the output at all.
- A new case where every step is `completed`: fill is full width (`width:100%` in the rendered style) and the pulse span is absent (no active step).

## Error handling

None new — this is a pure derivation from data the component already receives; there is no new failure mode to handle (unlike, e.g., a network call or a tool dispatch).
