# Chat-based sessions — frontend (side panel UI)

**Date:** 2026-07-04
**Status:** Approved (conversation)

## Problem

The backend chat-sessions work (`docs/superpowers/specs/2026-07-03-chat-sessions-design.md`, merged) added `Session`/`SessionContext` IndexedDB stores, carried-forward facts/summary across turns, and four `session.*` `PanelCommand`s/one `sessions` `SwUpdate` — but deliberately left the side panel untouched. Today the panel still behaves like a one-shot tool: every goal is sessionless, there's no way to see or return to a past chat, and `App.tsx` doesn't even have a case for the `sessions` update it already receives. This spec builds the GPT-style chat surface on top of that backend: a session switcher, a scrolling transcript of past turns, and auto-continuation so a follow-up goal naturally lands in the same chat.

## Principle

Same evolutionary approach as the backend spec: add a thin layer on top of what exists rather than restructure it. The single-turn display (`Composer` → `RunState` → `ResultCard` → `Timeline`) is not touched — it keeps rendering whichever turn is currently active or most recently finished, exactly as today. What's new is *around* it: a switcher above it, and a transcript of everything before it.

## Design

### Backend extension: turns need structure, not just IDs

Tracing `Session.turnIds: string[]` end-to-end (state_store.ts, orchestrator.ts, messages.ts) shows only the *first* turn's goal is recoverable (`Session.title`) and only the *most recent* turn's summary is recoverable (`SessionContext.lastSummary`). A scrolling transcript needs goal + result for **every** turn. Rather than reconstruct that by parsing each turn's `"Task started: ..."` log line (fragile — breaks if that string ever changes), the session record itself carries it:

```ts
// shared/messages.ts
export interface SessionTurn {
  taskId: string;
  goal: string;
  verdict?: string;   // set once the turn reaches a terminal state
  summary?: string;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  lastActiveAt: number;
  turns: SessionTurn[];   // replaces turnIds: string[]
}
```

`appendTurnToSession(sessionId, taskId, goal?)` already receives `goal` (today used only for `title`) — it now also pushes `{ taskId, goal: goal ?? '' }` onto `turns`. A new `state_store.ts` function:

```ts
export async function updateSessionTurnResult(
  sessionId: string,
  taskId: string,
  verdict: string,
  summary: string,
): Promise<void> {
  try {
    const d = await db();
    const cur = (await d.get('sessions', sessionId)) as Session | undefined;
    if (!cur) return;
    const turns = cur.turns.map((t) => (t.taskId === taskId ? { ...t, verdict, summary: redact(summary) } : t));
    await d.put('sessions', { ...cur, turns });
  } catch {
    /* best-effort, same pattern as every other session write */
  }
}
```

Called from `orchestrator.ts`'s `finishOk`/`abortNow`, immediately next to the existing `saveSessionContext` call — same redaction boundary (`redact`, already imported there), same best-effort try/catch pattern, and the same `SESSION_SUMMARY_MAX` (500 char) cap `saveSessionContext` already applies to `lastSummary` — `updateSessionTurnResult` truncates before redacting, identically.

`cur.turns` is read as `cur.turns ?? []` in both `appendTurnToSession` and `updateSessionTurnResult` — defensive against any session record written by a pre-this-spec build of the merged backend work still holding the old `turnIds` shape in a developer's local IndexedDB (this spec ships before any such data would exist in a real release, but the fallback is one `??` and worth the safety).

This is the only backend change in this spec. `DB_VERSION` does not need to bump — `turns` replaces `turnIds` as a field on the same store, not a new store; existing empty installs are unaffected, and this ships alongside the frontend in the same release (no deployed data with the old shape to migrate).

### Auto-continuation, scoped to `agent.start`

`background/index.ts`'s `agent.start` case creates a session on demand:

```ts
case 'agent.start':
  if (!_activeSessionId) {
    const s = await createSession();
    _activeSessionId = s.id;
    await pushSessions();
  }
  void handleStart(cmd.goal);
  break;
```

`agent.askPage` is unchanged — it stays sessionless when no session is active (preserving the existing regression-test baseline that a sessionless turn is byte-identical to pre-session behavior), but if a session *is* already active, it still passes `_activeSessionId` through (that plumbing already exists in `handleStart`). "Ask about this page" is a quick utility, not a chat message; it shouldn't be what *starts* a chat, but it shouldn't fight one either. "Apply to a job" already calls `agent.start` under the hood, so it participates in auto-continuation for free — no separate change.

### Guarding session-mutating commands while a turn runs

`session.select` already refuses mid-run (`if (_orch || _starting)`). The same guard extends to:

- `session.new` — starting a fresh chat while one is running would silently orphan the live turn's `_activeSessionId` out from under it.
- `session.delete` — only when the id being deleted is `_activeSessionId` (deleting a *different*, inactive session while a turn runs is harmless and stays allowed).

```ts
async function handleSessionNew() {
  if (_orch || _starting) {
    broadcast({ type: 'error', message: 'A task is already running. Stop it first.' });
    return;
  }
  const s = await createSession();
  _activeSessionId = s.id;
  await pushSessions();
}

async function handleSessionDelete(sessionId: string) {
  if (sessionId === _activeSessionId && (_orch || _starting)) {
    broadcast({ type: 'error', message: 'A task is already running. Stop it first.' });
    return;
  }
  await deleteSession(sessionId);
  if (_activeSessionId === sessionId) _activeSessionId = null;
  await pushSessions();
}
```

### Broadcasting the updated session after a turn finishes

Caught during self-review: the frontend's existing `handleStart` (App.tsx) already does `setEvents([])` the moment the *next* goal is sent (unchanged, pre-existing behavior). Since `ResultCard`'s only data source today is `latestFinish(events)`, a follow-up goal wipes the *previous* turn's visible result out of memory before `Transcript` has any other copy to fall back to — without a fix, every earlier answer in an ongoing chat would flash away the instant the user asks a follow-up, then never come back (the `sessions` broadcast used to backfill it would still be holding the *pre-finish* turn list, since nothing re-pushes it when a turn completes).

`handleStart`'s existing `finally` block (`background/index.ts`) already calls `pushStatus()`/`pushMetrics()` once the run settles for real (`myRun === _runId`) — `pushSessions()` joins them there, guarded the same way the others already are:

```ts
finally {
  if (myRun === _runId) {
    stopKeepAlive();
    _orch = null;
    _abortController = null;
    await pushStatus();
    await pushMetrics();
    if (_activeSessionId) await pushSessions(); // picks up this turn's verdict/summary from updateSessionTurnResult
  }
}
```

This lands *after* `finishOk`/`abortNow` (called from inside `runUntilTerminal`, which the `try` block already awaited) have written `updateSessionTurnResult`, so the freshly-pushed `Session.turns` entry already carries the finished verdict/summary — `Transcript` picks it up the moment `events` goes empty, with no gap where the answer is missing from both places at once.

### Frontend: new panel state

`App.tsx` gains:

```ts
const [sessions, setSessions] = useState<Session[]>([]);
const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
```

New case in the existing `onUpdate` switch (the `sessions` update type already exists in `SwUpdate` but has no handler today):

```ts
case 'sessions':
  setSessions(msg.sessions);
  setActiveSessionId(msg.activeSessionId);
  break;
```

`client.send({ type: 'session.list' })` added alongside the existing mount-time sends (`settings.get`, `agent.status`, `models.list`, `preflight`).

Because session switches are only reachable while nothing is running (guarded above), it's safe to reset `events`/`runStartedAt`/`notice` to their empty states whenever `activeSessionId` changes — a `useEffect` keyed on `activeSessionId`. This is what makes it structurally impossible to show turn data from the wrong session: the moment the active session changes, the single-turn display has nothing to show until the next `status`/`timeline` update arrives for the newly active session.

### Frontend: two new components, one small extraction

**`components/SessionSwitcher.tsx`** — sits directly above `Composer` in the `agent` tab. Modeled on `RecipesPanel`'s existing list pattern (`<select>` of sessions + a detail/actions row), same `card`/`row-between`/`btn-sm` classes, no new CSS concepts:

```tsx
interface Props {
  sessions: Session[];
  activeSessionId: string | null;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

export function SessionSwitcher({ sessions, activeSessionId, onNew, onSelect, onDelete }: Props) {
  const active = sessions.find((s) => s.id === activeSessionId);
  return (
    <div className="card session-switcher">
      <div className="row-between">
        <select
          className="recipe-select"
          value={activeSessionId ?? ''}
          onChange={(e) => onSelect(e.target.value)}
        >
          {!active && <option value="">New chat</option>}
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title || 'New chat'}
            </option>
          ))}
        </select>
        <div className="session-actions">
          <button className="btn btn-sm" onClick={onNew}>
            <Icon name="plus" size={12} /> New chat
          </button>
          {active && (
            <button className="btn btn-sm btn-danger" onClick={() => onDelete(active.id)}>
              <Icon name="x" size={12} /> Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
```

Wired in `App.tsx`:

```tsx
<SessionSwitcher
  sessions={sessions}
  activeSessionId={activeSessionId}
  onNew={() => send({ type: 'session.new' })}
  onSelect={(id) => send({ type: 'session.select', sessionId: id })}
  onDelete={(id) => send({ type: 'session.delete', sessionId: id })}
/>
```

**`components/Transcript.tsx`** — renders every turn *except* the last as a compact static bubble (no interactivity, no expand/collapse — that's what `Timeline` is for the live turn):

```tsx
import { renderRich } from '../view/format';
import { describeVerdict } from '../view/format';
import type { SessionTurn } from '@/shared/messages';

export function Transcript({ turns }: { turns: SessionTurn[] }) {
  if (turns.length === 0) return null;
  return (
    <div className="transcript">
      {turns.map((t) => (
        <div key={t.taskId} className="transcript-turn">
          <div className="transcript-goal">{t.goal}</div>
          {t.summary != null && (
            <div className="transcript-result">
              <span className={`verdict ${describeVerdict(t.verdict ?? '').tone}`}>
                {describeVerdict(t.verdict ?? '').label}
              </span>
              <div className="transcript-summary">{renderRich(t.summary)}</div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
```

In `App.tsx`, placed above the existing `RunState`/`ResultCard`/`Timeline` block:

```tsx
<Transcript turns={(sessions.find((s) => s.id === activeSessionId)?.turns ?? []).slice(0, -1)} />
```

The last turn is excluded because `RunState`/`ResultCard` already render it — reusing them as-is rather than duplicating their treatment. `latestFinish(events)` remains `ResultCard`'s data source when the just-run turn's events are already in memory; when a user switches back into a session whose last turn finished in a previous panel session (events not in memory), `ResultCard` falls back to that turn's `SessionTurn.verdict`/`summary`:

```tsx
const activeSession = sessions.find((s) => s.id === activeSessionId);
const lastTurn = activeSession?.turns.at(-1);
const finish = latestFinish(events) ?? (lastTurn?.summary != null
  ? { verdict: lastTurn.verdict ?? '', summary: lastTurn.summary, sources: [] }
  : null);
```

**`renderRich` moves from `ResultCard.tsx` to `view/format.ts`** — the one justified extraction, since `Transcript` now needs the identical rendering. `ResultCard.tsx` imports it from its new home; no behavior change.

## Trade-off

`SessionTurn.summary`/`goal` are stored a second time (already present, unredacted at the source, inside each turn's own `finish`/`log` events in the `events` IndexedDB store) — this is intentional duplication, not drift: the `events` store is queried by `taskId` and was never meant to be scanned across a whole session, while `Session.turns` is the cheap, already-redacted, direct-from-`sessions`-broadcast path the transcript needs on every session switch. Same redaction boundary is applied to both copies (`saveSessionContext` and `updateSessionTurnResult` both redact), so there's no new unredacted surface.

Deleting a session does not cascade-delete its turns' underlying `events`/`findings` records — unchanged from the backend spec's existing "Explicitly NOT doing" — so a deleted session's turn data can still be found by taskId if something else references it directly. Not a new gap introduced by this spec.

## Explicitly NOT doing

- No new tab — the switcher lives inline in the existing Agent tab, per the chosen design.
- No editing, branching, or regenerating past turns — transcript bubbles are read-only static text.
- No interactivity inside transcript bubbles (no expand/collapse, no per-turn Timeline access) — only the active/most-recent turn gets the full `RunState`/`Timeline` treatment.
- No changes to `agent/framework/`, `agent/safety/`, `agent/tools/`, or any `roles/*.ts` prompt beyond what the backend spec already merged.
- No fix for the theoretical race between deleting a session's record and an in-flight `sessionContext`/turn-result write landing after — same class of accepted gap as the backend spec's own turnIds-recorded-at-start note; not reachable through the UI since delete-while-running-and-active is now guarded.

## Testing (TDD)

- `state_store.ts`: `appendTurnToSession` now records `{taskId, goal}` in `turns`, not just `turnIds`; a session with no `updateSessionTurnResult` call yet has `turns[i].verdict`/`summary` both `undefined`; `updateSessionTurnResult` patches the matching entry by `taskId` and redacts the summary (reuse the existing PII regression-test pattern from `saveSessionContext`'s test).
- `orchestrator.ts` integration test: a two-turn session where turn 1 finishes — assert the session's `turns[0]` has `verdict`/`summary` populated after `finishOk`, and turn 2's abort path populates `turns[1]` via `abortNow`.
- `background_run_lifecycle.test.ts`: `agent.start` with no active session creates one first (assert `state().activeSessionId` is non-null after); `session.new`/`session.delete`-of-active both refuse while `orchSet`/`starting`, mirroring the existing `session.select` refusal test; a turn that finishes while a session is active results in a `sessions` broadcast whose matching `Session.turns` entry carries the finished verdict/summary (fake orchestrator's `finishRun()` triggers the real `finally` block, same pattern the existing lifecycle tests already use).
- Frontend: `tests/unit/components_render.test.tsx` already covers every existing sidepanel component with `renderToStaticMarkup` (static states) and `react-dom/client` + `act` (interactive states, e.g. the `SettingsPanel` provider round-trip test) — `SessionSwitcher` and `Transcript` get the same treatment, added to that file: `SessionSwitcher` renders the active session's title, lists past sessions in the dropdown, and shows "New chat" when none is active; `Transcript` renders each non-last turn's goal + verdict + summary and renders nothing (`toBe('')`) for an empty list, mirroring the existing `Timeline` empty-state assertion.
- Manual verification (App.tsx wiring doesn't reduce to a pure render check — it needs the live port/background loop): start a goal with no session active → a session appears in the switcher; send a follow-up goal → it lands in the same session's transcript; switch to a different (new) session mid-idle → composer/result clear; switch back → the finished turn's result reappears from `Session.turns`, not from stale `events`.

## Implementation notes

Touches: `shared/messages.ts` (`SessionTurn` type, `Session.turns` replacing `turnIds`), `background/state_store.ts` (`appendTurnToSession` stores the turn object, new `updateSessionTurnResult`), `agent/orchestrator.ts` (`finishOk`/`abortNow` call `updateSessionTurnResult`), `background/index.ts` (`agent.start` auto-creates a session, `session.new`/`session.delete`-of-active guarded, `handleStart`'s `finally` pushes `sessions`), `sidepanel/App.tsx` (`sessions`/`activeSessionId` state, `sessions` case, reset-on-switch effect, renders `SessionSwitcher` + `Transcript`), `sidepanel/components/SessionSwitcher.tsx` (new), `sidepanel/components/Transcript.tsx` (new), `sidepanel/components/ResultCard.tsx` (import `renderRich` instead of defining it), `sidepanel/view/format.ts` (`renderRich` moves here), `sidepanel/styles.css` (a handful of new classes: `.session-switcher`, `.session-actions`, `.transcript`, `.transcript-turn`, `.transcript-goal`, `.transcript-result`, `.transcript-summary` — following existing BEM-ish naming, no new design tokens needed), `tests/unit/components_render.test.tsx` (new render-safety tests for `SessionSwitcher`/`Transcript`).
