# Fix session continuity: persist active session, restore full turn trace

**Date:** 2026-07-04
**Status:** Approved (conversation)

## Problem

Live testing of the just-shipped chat-sessions feature surfaced two related but distinct bugs, both striking at the core "continuity" promise the whole feature exists to deliver:

**Bug 1 — a second message in the same conversation silently starts a NEW session instead of continuing the current one.** Root cause, traced directly: `_activeSessionId` (`background/index.ts`) — the pointer to "which session is currently active" — lives only as a plain in-memory module variable, never persisted anywhere. Chrome kills an idle MV3 service worker after ~30 seconds of inactivity, which is completely normal mid-conversation (reading a reply, composing the next message). When the SW restarts, `_activeSessionId` resets to `null` with no signal to the panel that this happened. The next `agent.start` sees no active session and — per the existing, working-as-designed auto-continue logic — creates a brand new one. Nothing is deleted: session 1's data sits untouched in IndexedDB the whole time (which is exactly why it's still selectable in the switcher dropdown afterward) — the bug is purely about losing track of *which* session is current, not about data loss.

**Bug 2 — selecting a past session in the switcher shows only its final result, not the actual run.** This was a deliberate scope decision in the original design (`Transcript`'s bubbles are explicitly non-interactive, "no per-turn Timeline access"), but seeing it live, it reads as "the run itself is gone," not "here's a compact history." The backend already persists every turn's complete step-by-step trace in IndexedDB (`state_store.ts`'s `loadEvents(taskId)`) — it's simply never been exposed to the panel for anything other than the currently-live run.

## Design

### Fix 1: persist `_activeSessionId` across service-worker restarts

`state_store.ts` gains a small persisted value alongside the existing `AgentStateHot` (`chrome.storage.local`, same `_storage` shim already used by `loadHot`/`patchHot`/`_setHot`):

```ts
const ACTIVE_SESSION_KEY = 'agent.activeSessionId';

export async function loadActiveSessionId(): Promise<string | null> {
  return ((await _storage.get(ACTIVE_SESSION_KEY)) as string | undefined) ?? null;
}

export async function saveActiveSessionId(id: string | null): Promise<void> {
  if (id === null) await _storage.remove(ACTIVE_SESSION_KEY);
  else await _storage.set(ACTIVE_SESSION_KEY, id);
}
```

In `background/index.ts`, the module-level `let _activeSessionId` stays (it's still the fast, synchronous read every existing check like `if (!_activeSessionId)` relies on), but every WRITE to it goes through one new helper instead of a bare assignment:

```ts
async function setActiveSessionId(id: string | null): Promise<void> {
  _activeSessionId = id;
  await saveActiveSessionId(id);
}
```

The four existing assignment sites (`handleSessionNew`, `handleSessionSelect`, `handleSessionDelete`, the `agent.start` auto-create branch) each change their bare `_activeSessionId = ...` to `await setActiveSessionId(...)`. This makes "forgot to persist" structurally impossible for any *future* mutation site too, not just today's four.

`crashResume()` (already the established "runs once per SW startup" hook — it already restores stale hot state) also restores this:

```ts
async function crashResume(): Promise<void> {
  try {
    const hot = await loadHot();
    if (hot && hot.phase !== 'IDLE' && hot.phase !== 'DONE' && hot.phase !== 'ABORTED') {
      console.warn('[browser-agent] crash-resume: found in-flight task, marking ABORTED');
      await patchHot({ phase: 'ABORTED' });
    }
    const restored = await loadActiveSessionId();
    // Defensive: don't resurrect a pointer to a session that no longer exists (e.g. IndexedDB
    // was cleared independently of chrome.storage.local — the two aren't transactional).
    if (restored && !(await listSessions()).some((s) => s.id === restored)) {
      await saveActiveSessionId(null);
    } else {
      _activeSessionId = restored;
    }
  } catch (err) {
    console.warn('[browser-agent] crash-resume failed:', (err as Error)?.message);
  }
}
```

**The startup race, and why it needs a fix, not just a restore:** `crashResume()` runs unawaited at module load (`void crashResume();`). The panel's port can connect and send `session.list` before that promise settles — a real, previously-latent race that only becomes observable now that `crashResume` does async work relevant to `_activeSessionId` (before this fix, nothing the panel asked for on startup depended on `crashResume` finishing at all). Fix: capture `crashResume()`'s promise at module scope and `await` it as the very first line inside `port.onMessage`'s handler, before the `switch`. This guarantees every command processes after startup restoration completes, at the cost of one already-resolved-promise await per command after the first (effectively free).

### Fix 2: restore the most recent turn's full trace when switching sessions

New command/update pair, mirroring the shape of every other read-and-broadcast pair already in `shared/messages.ts`:

```ts
// PanelCommand
| { type: 'session.turnEvents'; taskId: string }
// SwUpdate
| { type: 'turnEvents'; taskId: string; events: TimelineEvent[] }
```

Handler in `background/index.ts`:

```ts
case 'session.turnEvents':
  broadcast({ type: 'turnEvents', taskId: cmd.taskId, events: await loadEvents(cmd.taskId) });
  break;
```

This is a thin wrapper — `loadEvents` already exists and already does exactly this read; today it's just never called for anything other than the live run's own `taskId` (implicitly, via the currently-running `Orchestrator` instance's own event emission, not this command).

On the frontend, `App.tsx`'s existing reset-on-session-switch effect changes shape. Today it unconditionally clears `events`:

```ts
if (prevSessionId.current !== activeSessionId) {
  prevSessionId.current = activeSessionId;
  setEvents([]);
  setNotice(null);
  setRunStartedAt(null);
}
```

It becomes: if the newly-active session has a most-recent turn, request that turn's real trace instead of clearing to empty; the `case 'turnEvents':` branch (new, alongside the existing `case 'sessions':` etc.) populates `events` once the response arrives:

```ts
if (prevSessionId.current !== activeSessionId) {
  prevSessionId.current = activeSessionId;
  setNotice(null);
  setRunStartedAt(null);
  const lastTaskId = sessions.find((s) => s.id === activeSessionId)?.turns.at(-1)?.taskId;
  if (lastTaskId) {
    send({ type: 'session.turnEvents', taskId: lastTaskId });
  } else {
    setEvents([]); // a session with no turns yet — nothing to restore
  }
}
```

No changes to `Timeline`, `RunState`, or `ResultCard` — all three are already 100% driven by the `events` array (and, for `ResultCard`, the existing `Session.turns`-fallback for `verdict`/`summary` already built in the prior cycle), so populating `events` with the real historical trace instead of `[]` is the entire fix; the rendering pipeline doesn't know or care whether the data came from a live run or a restore.

**Same fetch, applied to the cold-open case too.** The effect's `prevSessionId.current === undefined` branch (first render after the panel opens fresh — a different trigger than switching sessions while the panel stays open, but the exact same underlying gap) currently returns immediately with no fetch at all, meaning a freshly-opened panel shows the empty state for a session that actually has history, until the user manually reselects it. Since Fix 2 is already restructuring this exact effect, both branches request the trace the same way:

```ts
if (prevSessionId.current === undefined) {
  prevSessionId.current = activeSessionId;
  const lastTaskId = sessions.find((s) => s.id === activeSessionId)?.turns.at(-1)?.taskId;
  if (lastTaskId) send({ type: 'session.turnEvents', taskId: lastTaskId });
  return;
}
```

One ordering note this relies on: this effect depends on `[activeSessionId]`, but the lookup needs `sessions` to already be populated. Since both `sessions` and `activeSessionId` arrive together in the single `case 'sessions':` broadcast (`setSessions(msg.sessions); setActiveSessionId(msg.activeSessionId);`), and React batches same-event state updates, `sessions` is guaranteed current by the time this effect's callback runs — no separate ordering fix needed, just calling it out since it's load-bearing for both branches now, not only the switch-while-open one.

## Explicitly NOT doing

- No change to `Transcript`'s own scope — older (non-most-recent) turns in a session stay as compact, non-interactive summary bubbles. Only the single most recent turn (the one that already gets `ResultCard`'s hero treatment) gets its full trace restored, matching exactly what the bug report described.
- No retroactive migration or backfill for sessions created before this fix ships — `_activeSessionId` simply starts unpersisted-until-now; the very next SW restart after this ships persists correctly, nothing needs to be repaired for existing IndexedDB data (session/turn records themselves were never wrong, only the ephemeral "which one is active" pointer).
- No change to how `agent.askPage` or the chitchat fast path (`quick_chat.ts`) interact with sessions — both are already deliberately sessionless by design; this spec doesn't touch that boundary.

## Testing

- `state_store.ts`: `saveActiveSessionId`/`loadActiveSessionId` round-trip, including the `null`-removes-the-key case.
- `background_run_lifecycle.test.ts`: a `crashResume()` test proving a previously-saved `activeSessionId` is restored into `_testing.state().activeSessionId` on the next call, including the defensive case (saved ID no longer exists in `listSessions()` → resets to `null`). A second test proving `session.turnEvents` broadcasts `loadEvents(taskId)`'s actual content for an arbitrary `taskId`, not just the live run's.
- No new frontend test file (matches this codebase's established convention — `App.tsx` has no dedicated test suite); the switch-restores-trace behavior is covered by the backend-side `session.turnEvents` test proving the data is correctly fetchable, plus manual verification once shipped, same as every other layout/wiring change this project has shipped.

## Implementation notes

Touches: `background/state_store.ts` (new `loadActiveSessionId`/`saveActiveSessionId`), `background/index.ts` (`setActiveSessionId` helper replacing 4 bare assignments, `crashResume`'s restore logic, the awaited-crashResume-promise fix, new `session.turnEvents` case), `shared/messages.ts` (`session.turnEvents` `PanelCommand`, `turnEvents` `SwUpdate`), `sidepanel/App.tsx` (reset-on-session-switch effect now requests/consumes the real trace instead of clearing to empty).
