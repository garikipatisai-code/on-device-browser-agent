# Anti-bot block detect-and-pause — design

## Motivation

The agent has no way to distinguish "this page is legitimately hard to navigate" from "this page has detected automation and is actively blocking it" (captchas, Cloudflare/Akamai/PerimeterX-style interstitials, generic "unusual traffic"/"access denied" walls). Today it just keeps trying, eventually tripping the circuit breaker or exhausting turns with no honest signal about *why*.

A prior request in this project's history asked for the agent to automatically *solve* these challenges (sliders, puzzles, etc.). That was explicitly declined: solving anti-bot challenges is categorically different from making legitimate actions more reliable — it's defeating a detection mechanism regardless of the specific task's intent, it's not something even funded competitors ship as local/open code, and it would blur a line this project otherwise draws carefully (see the conversation record, 2026-07-05). This spec is the accepted alternative: **detect the block, pause the run, let the human resolve it in the visible tab, then continue automatically once it's gone.** No bypass, no solving — just honest recognition that this one part of the flow requires a human, the same way the codebase already refuses to auto-submit job applications.

## Scope

In scope:
1. A deterministic detector for anti-bot blocks (broader than literal CAPTCHA widgets — any bot-detection interstitial/block page), modeled directly on the existing `findConsentDismiss` pattern.
2. Wiring it into the same place consent-wall detection already runs (`orchestrator.ts`'s `autoObserveAfterNavigation`).
3. A bounded-in-effort-but-unbounded-in-time polling wait (modeled on `waitForTabSettled`'s shape) that re-checks until the block clears.
4. A new `TaskPhase` value (`'BLOCKED'`) and side-panel banner treatment.
5. Two new `TimelineEvent` kinds (`antibot.blocked`, `antibot.resolved`) for the timeline/log.

Out of scope (per explicit user decisions during design):
- Solving/bypassing any anti-bot challenge. Detection and pause only.
- Native OS notifications (`chrome.notifications`) — side-panel banner only, no new manifest permission.
- A manual "Resume now" button — resolution is auto-detected via polling only. The existing `agent.abort`/Stop button remains the only manual control while blocked.
- Exhaustive vendor coverage. The pattern list is a starting set (Cloudflare, Google's block page, Akamai, common CAPTCHA vendor names, generic phrasing) — like `findConsentDismiss`, it will miss vendors not yet seen, and a miss just means no pause (never a wrong action), which is an accepted, non-catastrophic gap.

## Detection

New file `extension/src/agent/tools/browser/antibot.ts`, same shape as the existing `consent.ts` (pure function over already-extracted ARIA text, no LLM call, no new CDP calls):

```typescript
export interface AntiBotBlock {
  label: string; // human-readable, goes in the timeline event and banner
}

export function detectAntiBotBlock(ariaText: string): AntiBotBlock | null;
```

Starting pattern set (case-insensitive), each an independent signal — any one match is sufficient:
- Cloudflare: `checking your browser`, `ddos protection by cloudflare`, `cf-browser-verification`
- Google's block page: `unusual traffic from your computer network`, `our systems have detected unusual traffic`
- Akamai: `pardon the interruption`, `reference #` + `access denied` combination
- Generic CAPTCHA vendor names/widgets: `recaptcha`, `hcaptcha`, `cloudflare turnstile`, `arkose`, `funcaptcha`
- Generic phrasing: `verify you are human`, `i'm not a robot`, `are you a robot`, `access denied` + `bot`-adjacent context, `please complete the security check`

No dual-signal guard is needed here the way `findConsentDismiss` needs one (consent walls need to avoid false-triggering on ordinary "cookie" mentions in unrelated text) — these phrases are specific enough on their own that a single match is a reasonable bar. If real-world false positives show up, tighten individual patterns then, not preemptively.

## Wiring

In `orchestrator.ts`'s `autoObserveAfterNavigation`, right after the initial fresh read (`this.recordObserved(obs.content, obsUrl)` and its log emit) and *before* the existing consent-wall check:

1. Run `detectAntiBotBlock(obs.content)`.
2. If no match, proceed to the existing consent-check logic unchanged.
3. If matched:
   - Emit `{kind: 'antibot.blocked', ts, label}`.
   - Transition the live phase to `'BLOCKED'` (`patchHot({phase: 'BLOCKED'})` — the exact call shape needs confirming against the current file when this is planned in detail).
   - Enter the polling wait (see below).
   - On resolution, emit `{kind: 'antibot.resolved', ts}`, transition the phase back to `'EXECUTING'` (safe to hardcode — `autoObserveAfterNavigation` is only ever reached mid-turn, during `EXECUTING`, confirmed by reading the call site), update `this.lastRead`/`recordObserved` with the resolved page's content, and return — skipping the consent-check for this turn (an accepted gap: if the resolved page also shows a cookie banner, it's caught on the *next* navigation's auto-observe rather than immediately; not solving every combination up front).

## Polling wait

Modeled on `waitForTabSettled`'s existing shape (`extension/src/agent/tools/browser/tab.ts`) but living in `orchestrator.ts` since it needs to dispatch `aria.extract` through the tool registry and emit timeline events, not just poll `chrome.tabs.get`:

- Poll interval: a few seconds (long enough not to hammer the page with re-extracts while someone's mid-solve; short enough that resolution feels prompt once they're done).
- No timeout that gives up automatically — the whole point is "wait until you get back to it," which could be minutes. The run stays in `BLOCKED` indefinitely; the existing Stop button is the escape hatch if the user wants to abandon it instead of waiting.
- Each poll: re-dispatch `aria.extract` on the same tab, re-run `detectAntiBotBlock` on the result. Clean read with no match → resolved.
- If `aria.extract` itself fails on a given poll (tab closed, navigated away, transient error) — treat as inconclusive, not resolved; keep polling rather than either falsely resolving or crashing the run. (Mirrors this codebase's existing fail-open-on-uncertainty pattern, e.g. `isPointOccluded` from the tool-execution-reliability work.)

## UI

- `shared/messages.ts`: add `'BLOCKED'` to the `TaskPhase` union; add the two new `TimelineEvent` kinds.
- `sidepanel/view/phase.ts`: add a `case 'BLOCKED':` to `describePhase` → label along the lines of "Waiting for you to resolve a check on the page", tone `'error'` (reuses the existing tone palette — this isn't a failure, but it's the same "needs attention" visual treatment as one), `busy: true`. No change needed to `isRunning` — its existing exclusion list (`IDLE`/`DONE`/`ABORTED`) already treats any other phase, including the new `BLOCKED`, as "running," which correctly keeps the Stop affordance visible.
- No new side-panel components required beyond whatever renders `RunState`'s existing phase pill — confirm during implementation whether the `antibot.blocked` event's `label` should also surface in the timeline log view (recommended: yes, for the same reason every other `log`-adjacent event does — visibility into what the agent is doing/waiting for).

## Testing

Following this codebase's existing test conventions:
- `antibot.test.ts` (new, mirrors `consent.test.ts`'s shape if one exists, or the general unit-test style otherwise): a table of sample ARIA-text snippets per vendor pattern, asserting a match, plus a few ordinary-page snippets asserting no match (guards against overly broad patterns).
- `orchestrator.ts`'s existing test suite gets new cases: a navigating action that lands on a blocked page (mocked `aria.extract` response containing a block phrase) enters `BLOCKED` and emits `antibot.blocked`; the polling loop resolves once a subsequent mocked `aria.extract` comes back clean, emitting `antibot.resolved` and reverting phase; a poll that keeps returning blocked content stays in `BLOCKED` (bounded test iterations, not a real multi-minute wait — use a short poll interval injected/mocked for the test).
- `phase.test.ts` (if one exists) or wherever `describePhase`/`isRunning` are currently tested: add the `BLOCKED` case.

## Non-goals (restated for clarity)

- Not detecting *which* anti-bot vendor/mechanism is present beyond a human-readable label — behavior is identical (pause) regardless of vendor, so no vendor-specific branching exists or is planned.
- Not attempting to solve, click through, or otherwise interact with the challenge itself.
- Not adding a manual override to force-resume before the poll detects resolution — if this proves annoying in practice, that's a candidate for a future, separately-specced addition, not part of this work.
