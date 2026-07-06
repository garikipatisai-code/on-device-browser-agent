# Run Progress Meter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a visual progress bar to the side panel's `RunState` card that shows real plan-step completion (`done/total`) while a task runs, so the user isn't limited to a pulsing phase dot and a wall-clock timer.

**Architecture:** Pure presentation change. `RunState` already receives the live `Plan` as a prop; it derives `{total, done, activeIndex}` via the existing, already-unit-tested `planProgress()` helper (`sidepanel/view/result.ts`) and renders a filled bar + text label from that. No new props, no orchestrator change, no new message types.

**Tech Stack:** React (function component, no new hooks/state), plain CSS (existing design-token system in `styles.css`), Vitest + `react-dom/server`'s `renderToStaticMarkup` for tests (matching this file's existing pattern).

**Spec:** `docs/superpowers/specs/2026-07-05-run-progress-meter-design.md`

---

### Task 1: Progress meter in RunState

**Files:**
- Modify: `extension/src/sidepanel/components/RunState.tsx`
- Modify: `extension/src/sidepanel/styles.css`
- Test: `extension/tests/unit/components_render.test.tsx`

- [ ] **Step 1: Write the failing tests**

Open `extension/tests/unit/components_render.test.tsx`. Find this existing test (it uses the file's top-level `plan` fixture: 1 `completed` step, 1 `active` step, 1 `pending` step):

```tsx
  it('RunState renders the human phase label + every plan step', () => {
    const html = renderToStaticMarkup(<RunState phase="EXECUTING" plan={plan} elapsedMs={95_000} />);
    expect(html).toContain('Working in the page'); // not the raw "EXECUTING"
    expect(html).not.toContain('EXECUTING');
    expect(html).toContain('Search for the product');
    expect(html).toContain('Report the price');
    expect(html).toContain('1m 35s');
  });
```

Replace it with this (adds progress-meter assertions to the existing case, plus two new cases) — this REPLACES the single `it(...)` block above with three:

```tsx
  it('RunState renders the human phase label + every plan step + the progress meter', () => {
    const html = renderToStaticMarkup(<RunState phase="EXECUTING" plan={plan} elapsedMs={95_000} />);
    expect(html).toContain('Working in the page'); // not the raw "EXECUTING"
    expect(html).not.toContain('EXECUTING');
    expect(html).toContain('Search for the product');
    expect(html).toContain('Report the price');
    expect(html).toContain('1m 35s');
    expect(html).toContain('1 of 3 steps');
    expect(html).toMatch(/role="progressbar"/);
    expect(html).toMatch(/aria-valuenow="1"/);
    expect(html).toMatch(/aria-valuemax="3"/);
  });

  it('RunState shows no progress meter before a plan exists', () => {
    const html = renderToStaticMarkup(<RunState phase="PLANNING" plan={null} elapsedMs={2_000} />);
    expect(html).not.toMatch(/role="progressbar"/);
    expect(html).not.toContain('steps');
  });

  it('RunState progress meter is full width with no pulse once every step is resolved', () => {
    const donePlan: Plan = {
      created: 0,
      steps: [
        { id: 'a', description: 'Search for the product', successCriteria: 'results', status: 'completed' },
        { id: 'b', description: 'Open the first result', successCriteria: 'opened', status: 'completed' },
      ],
    };
    const html = renderToStaticMarkup(<RunState phase="EVALUATING" plan={donePlan} elapsedMs={1_000} />);
    expect(html).toContain('2 of 2 steps');
    expect(html).toMatch(/aria-valuenow="2"/);
    expect(html).toMatch(/width:100%/);
    expect(html).not.toContain('progress-fill-pulse');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npx vitest run tests/unit/components_render.test.tsx`
Expected: FAIL — the two new `it` blocks fail because `role="progressbar"` never appears in `RunState`'s current output; the first (replaced) test fails on the new `1 of 3 steps` / `aria-valuenow` assertions.

- [ ] **Step 3: Implement the progress meter in RunState**

Replace the full contents of `extension/src/sidepanel/components/RunState.tsx` with:

```tsx
import type { Plan, TaskPhase } from '@/shared/messages';
import { describePhase } from '../view/phase';
import { formatElapsed } from '../view/format';
import { planProgress } from '../view/result';
import { Icon } from './Icon';

/** Live status while the agent works: friendly phase + elapsed + a step-completion progress
 *  meter + the plan as a checklist. */
export function RunState({
  phase,
  plan,
  elapsedMs,
}: {
  phase: TaskPhase;
  plan: Plan | null;
  elapsedMs: number;
}) {
  const info = describePhase(phase);
  const progress = planProgress(plan);
  return (
    <div className="card runstate">
      <div className={`phase ${info.tone}`}>
        <span className="phase-dot" />
        <span className="phase-label">{info.label}</span>
        {info.busy && (
          <span className="elapsed">
            <Icon name="spinner" size={12} /> {formatElapsed(elapsedMs)}
          </span>
        )}
      </div>

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
          <span className="progress-label">
            {progress.done} of {progress.total} steps
          </span>
        </div>
      )}

      {plan && plan.steps.length > 0 && (
        <ul className="plan" aria-label="Plan progress">
          {plan.steps.map((s) => (
            <li key={s.id} className={`plan-step ${s.status}`}>
              <span className={`step-marker ${s.status}`}>
                {s.status === 'completed' && <Icon name="check" size={11} />}
                {s.status === 'failed' && <Icon name="x" size={11} />}
                {s.status === 'active' && <Icon name="spinner" size={13} />}
              </span>
              <span className="step-text">{s.description}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Add the CSS**

In `extension/src/sidepanel/styles.css`, find the `/* ---------- run state ---------- */` section (it currently ends with the `.elapsed` rule, right before `/* plan checklist */`). Add these four rules immediately after the existing `.elapsed` rule and before the `/* plan checklist */` comment:

```css
.progress-meter { display: flex; align-items: center; gap: var(--sp-2); }
.progress-track { flex: 1; height: 6px; border-radius: var(--r-pill); background: var(--surface-2); }
.progress-fill { position: relative; height: 100%; border-radius: var(--r-pill); background: var(--accent); transition: width 300ms ease; }
.progress-fill-pulse { position: absolute; right: -3px; top: 50%; transform: translateY(-50%); width: 6px; height: 6px; border-radius: 50%; background: var(--accent); animation: pulse 1.4s ease-in-out infinite; }
.progress-label { flex: none; font-size: 11.5px; color: var(--fg-mute); font-variant-numeric: tabular-nums; }
```

No changes needed to the reduced-motion block (`@media (prefers-reduced-motion: reduce)`) — its existing `*, *::before, *::after` selector already covers the new `.progress-fill` transition and `.progress-fill-pulse` animation.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd extension && npx vitest run tests/unit/components_render.test.tsx`
Expected: PASS — all three `it` blocks (the updated one + two new ones) pass.

- [ ] **Step 6: Run the full verification suite**

Run: `cd extension && npm run typecheck && npm run build && npm test`
Expected: typecheck clean, build succeeds, all tests pass (625+ previously-passing tests still pass, plus the new/changed ones from Step 5).

- [ ] **Step 7: Commit**

```bash
cd extension
git add src/sidepanel/components/RunState.tsx src/sidepanel/styles.css tests/unit/components_render.test.tsx
git commit -m "$(cat <<'EOF'
feat(sidepanel): add a real plan-step progress meter to RunState

Renders a filled bar (done/total from the existing planProgress()
helper) plus a pulsing leading-edge dot while a step is active, so a
run in progress has an actual-progress signal beyond the phase dot
and elapsed timer.
EOF
)"
```

---

## Plan self-review

**Spec coverage:** Data source (`planProgress`, existing/unused helper) ✓ Step 3. Placement between phase row and checklist ✓ Step 3. Markup shape incl. `aria-*` ✓ Step 3. CSS incl. no-`overflow:hidden` track/fill radius reasoning ✓ Step 4. Reduced-motion (no new CSS needed) ✓ noted in Step 4. Testing (no-plan absent, mixed-plan fraction, all-done full-width-no-pulse) ✓ Step 1. Out-of-scope items (tab badge, header indicator, sub-step estimate, turn-based bar) — no tasks reference them, correctly absent.

**Placeholder scan:** No TBD/TODO; every step has complete, real code (full replacement file for Step 3, exact CSS block for Step 4, exact test code for Step 1); no "similar to Task N" back-references (this plan has only one task).

**Type consistency:** `planProgress`'s return type `{ total: number; done: number; activeIndex: number }` (from `sidepanel/view/result.ts`) is used identically in the Step 3 JSX (`progress.total`, `progress.done`, `progress.activeIndex`) and in the Step 1 test assertions (`aria-valuenow="1"` for `done=1`, `aria-valuemax="3"` for `total=3`). `Plan`/`TaskPhase` types are imported exactly as the pre-existing file already imports them — no signature changes to `RunState`'s own props.
