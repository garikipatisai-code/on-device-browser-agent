# Anti-Bot Block Detect-and-Pause Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect anti-bot blocks (captchas, Cloudflare/Akamai-style interstitials, generic access-denied walls) after a navigation, pause the run, and auto-resume once the block clears — never attempt to solve or bypass it.

**Architecture:** A new pure detector function (mirroring the existing `findConsentDismiss` pattern) runs against the same post-navigation ARIA read the consent-wall check already uses. On a match, the orchestrator emits a `blocked` event, flips the live phase to `BLOCKED`, and polls (no timeout) until a fresh read comes back clean, then resumes the turn normally.

**Tech Stack:** TypeScript, the existing `Orchestrator`/`ToolRegistry` machinery, Vitest.

Spec: `docs/superpowers/specs/2026-07-05-antibot-pause-design.md`

---

## Before you start

Read `extension/src/agent/tools/browser/consent.ts`, `extension/src/agent/orchestrator.ts` (at least the `autoObserveAfterNavigation` method and the `OrchestratorOpts` interface), `extension/src/shared/messages.ts`, and `extension/src/sidepanel/view/phase.ts` before making any change. Run `npm test` once to confirm a clean baseline before starting.

---

### Task 1: Anti-bot block detector

**Files:**
- Create: `extension/src/agent/tools/browser/antibot.ts`
- Test: `extension/tests/unit/antibot.test.ts`

- [ ] **Step 1: Write the failing test**

Create `extension/tests/unit/antibot.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { detectAntiBotBlock } from '@/agent/tools/browser/antibot';

const CLOUDFLARE =
  `   heading "Just a moment..."\n` +
  `   text "checking your browser before accessing the site."`;

const GOOGLE_BLOCK =
  `   heading "Sorry..."\n` +
  `   text "Our systems have detected unusual traffic from your computer network."`;

const AKAMAI =
  `   heading "Access Denied"\n` +
  `   text "Pardon the Interruption..."`;

const RECAPTCHA_WIDGET =
  `   text "Please verify you are human"\n` +
  `[1] checkbox "I'm not a robot"\n` +
  `   text "reCAPTCHA"`;

const GENERIC_HUMAN_CHECK =
  `   heading "Security Check"\n` +
  `   text "Please complete the security check to continue."`;

const NORMAL =
  `   heading "Checkout"\n` +
  `[1] button "Place order"\n` +
  `[2] textbox "Card number"`;

describe('detectAntiBotBlock', () => {
  it('detects a Cloudflare browser-check interstitial', () => {
    expect(detectAntiBotBlock(CLOUDFLARE)).toEqual({ label: 'Cloudflare browser check' });
  });
  it("detects Google's automated-traffic block page", () => {
    expect(detectAntiBotBlock(GOOGLE_BLOCK)).toEqual({ label: 'Google automated-traffic block' });
  });
  it('detects an Akamai-style block page', () => {
    expect(detectAntiBotBlock(AKAMAI)).toEqual({ label: 'Akamai bot block' });
  });
  it('detects a reCAPTCHA widget by vendor name (checked before generic phrasing)', () => {
    expect(detectAntiBotBlock(RECAPTCHA_WIDGET)).toEqual({ label: 'CAPTCHA widget' });
  });
  it('detects generic human-verification phrasing with no vendor name present', () => {
    expect(detectAntiBotBlock(GENERIC_HUMAN_CHECK)).toEqual({ label: 'Generic human-verification wall' });
  });
  it('returns null on an ordinary page', () => {
    expect(detectAntiBotBlock(NORMAL)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run tests/unit/antibot.test.ts`
Expected: FAIL — `extension/src/agent/tools/browser/antibot.ts` doesn't exist yet (module not found).

- [ ] **Step 3: Implement**

Create `extension/src/agent/tools/browser/antibot.ts`:

```typescript
// Anti-bot block detection — captchas, Cloudflare/Akamai-style interstitials, generic
// "unusual traffic"/access-denied walls. Deterministic text matching only: this never attempts
// to solve, click through, or otherwise interact with any of these — it only recognizes that
// one is present, so the orchestrator can pause and let a human resolve it in the visible tab.
// Solving/bypassing anti-bot mechanisms is explicitly out of scope for this project — see
// docs/superpowers/specs/2026-07-05-antibot-pause-design.md.

export interface AntiBotBlock {
  label: string;
}

interface Pattern {
  label: string;
  re: RegExp;
}

// Checked in order — a page could plausibly match more than one (e.g. a CAPTCHA widget whose
// caption also contains generic "verify you are human" phrasing); vendor-specific patterns are
// listed before generic ones so a positive vendor identification takes precedence.
const PATTERNS: Pattern[] = [
  {
    label: 'Cloudflare browser check',
    re: /checking your browser|ddos protection by cloudflare|cf-browser-verification/i,
  },
  {
    label: 'Google automated-traffic block',
    re: /unusual traffic from your computer network|our systems have detected unusual traffic/i,
  },
  { label: 'Akamai bot block', re: /pardon the interruption/i },
  { label: 'CAPTCHA widget', re: /\b(recaptcha|hcaptcha|cloudflare turnstile|arkose|funcaptcha)\b/i },
  {
    label: 'Generic human-verification wall',
    re: /verify you are human|i'm not a robot|are you a robot|please complete the security check/i,
  },
];

/** The anti-bot block present on this page, or null if none of the known patterns match.
 *  A miss is a false negative (no pause), never a false positive that would block a legitimate
 *  page — like findConsentDismiss, this is a starting pattern set, not an exhaustive one. If
 *  real-world false positives show up, tighten individual patterns then, not preemptively. */
export function detectAntiBotBlock(ariaText: string): AntiBotBlock | null {
  for (const p of PATTERNS) {
    if (p.re.test(ariaText)) return { label: p.label };
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run tests/unit/antibot.test.ts`
Expected: PASS — all 6 tests.

- [ ] **Step 5: Typecheck**

Run: `cd extension && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add extension/src/agent/tools/browser/antibot.ts extension/tests/unit/antibot.test.ts
git commit -m "feat(agent): detect anti-bot blocks (captchas, interstitials, access-denied walls)"
```

---

### Task 2: `BLOCKED` phase and new timeline events

**Files:**
- Modify: `extension/src/shared/messages.ts` (the `TaskPhase` union, around line 4-11; the `TimelineEvent` union, around line 100-110)
- Modify: `extension/src/sidepanel/view/phase.ts`
- Test: `extension/tests/unit/phase.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `extension/tests/unit/phase.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { describePhase, isRunning } from '@/sidepanel/view/phase';

describe('describePhase', () => {
  it('describes BLOCKED as a busy, attention-needed state', () => {
    const info = describePhase('BLOCKED');
    expect(info.busy).toBe(true);
    expect(info.tone).toBe('error');
    expect(info.label).toMatch(/waiting/i);
  });
});

describe('isRunning', () => {
  it('treats BLOCKED as running (the Stop control should stay visible)', () => {
    expect(isRunning('BLOCKED')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run tests/unit/phase.test.ts`
Expected: FAIL — TypeScript error, `'BLOCKED'` is not assignable to `TaskPhase` yet.

- [ ] **Step 3: Implement**

In `extension/src/shared/messages.ts`, change the `TaskPhase` union (currently):

```typescript
export type TaskPhase =
  | 'IDLE'
  | 'PLANNING'
  | 'EXECUTING'
  | 'EVALUATING'
  | 'COMPACTING'
  | 'ABORTED'
  | 'DONE';
```

to:

```typescript
export type TaskPhase =
  | 'IDLE'
  | 'PLANNING'
  | 'EXECUTING'
  | 'EVALUATING'
  | 'COMPACTING'
  | 'BLOCKED'
  | 'ABORTED'
  | 'DONE';
```

In the same file, add two new variants to the `TimelineEvent` union (currently):

```typescript
export type TimelineEvent =
  | { kind: 'planner.plan'; ts: number; plan: Plan }
  | { kind: 'role.start'; ts: number; role: Role; stepId?: string }
  | { kind: 'role.end'; ts: number; role: Role; ms: number }
  | { kind: 'tool.call'; ts: number; tool: string; args: unknown }
  | { kind: 'tool.result'; ts: number; tool: string; ok: boolean; content: string }
  | { kind: 'evaluator.verdict'; ts: number; verdict: 'PASS' | 'FAIL'; reason: string }
  | { kind: 'breaker.trip'; ts: number; reason: string }
  | { kind: 'compaction'; ts: number; before: number; after: number }
  | { kind: 'log'; ts: number; level: 'info' | 'warn' | 'error'; message: string }
  | { kind: 'finish'; ts: number; verdict: string; summary: string; sources?: string[] };
```

to (inserting the two new variants after `breaker.trip`):

```typescript
export type TimelineEvent =
  | { kind: 'planner.plan'; ts: number; plan: Plan }
  | { kind: 'role.start'; ts: number; role: Role; stepId?: string }
  | { kind: 'role.end'; ts: number; role: Role; ms: number }
  | { kind: 'tool.call'; ts: number; tool: string; args: unknown }
  | { kind: 'tool.result'; ts: number; tool: string; ok: boolean; content: string }
  | { kind: 'evaluator.verdict'; ts: number; verdict: 'PASS' | 'FAIL'; reason: string }
  | { kind: 'breaker.trip'; ts: number; reason: string }
  | { kind: 'antibot.blocked'; ts: number; label: string }
  | { kind: 'antibot.resolved'; ts: number }
  | { kind: 'compaction'; ts: number; before: number; after: number }
  | { kind: 'log'; ts: number; level: 'info' | 'warn' | 'error'; message: string }
  | { kind: 'finish'; ts: number; verdict: string; summary: string; sources?: string[] };
```

In `extension/src/sidepanel/view/phase.ts`, add a case to `describePhase` (currently):

```typescript
export function describePhase(phase: TaskPhase): PhaseInfo {
  switch (phase) {
    case 'PLANNING':
      return { label: 'Planning the task', tone: 'busy', busy: true };
    case 'EXECUTING':
      return { label: 'Working in the page', tone: 'busy', busy: true };
    case 'EVALUATING':
      return { label: 'Checking the result', tone: 'busy', busy: true };
    case 'COMPACTING':
      return { label: 'Summarizing context', tone: 'busy', busy: true };
    case 'DONE':
      return { label: 'Done', tone: 'done', busy: false };
    case 'ABORTED':
      return { label: 'Stopped', tone: 'error', busy: false };
    case 'IDLE':
    default:
      return { label: 'Idle', tone: 'idle', busy: false };
  }
}
```

to (inserting a `BLOCKED` case before `DONE`):

```typescript
export function describePhase(phase: TaskPhase): PhaseInfo {
  switch (phase) {
    case 'PLANNING':
      return { label: 'Planning the task', tone: 'busy', busy: true };
    case 'EXECUTING':
      return { label: 'Working in the page', tone: 'busy', busy: true };
    case 'EVALUATING':
      return { label: 'Checking the result', tone: 'busy', busy: true };
    case 'COMPACTING':
      return { label: 'Summarizing context', tone: 'busy', busy: true };
    case 'BLOCKED':
      return { label: 'Waiting for you to resolve a check on the page', tone: 'error', busy: true };
    case 'DONE':
      return { label: 'Done', tone: 'done', busy: false };
    case 'ABORTED':
      return { label: 'Stopped', tone: 'error', busy: false };
    case 'IDLE':
    default:
      return { label: 'Idle', tone: 'idle', busy: false };
  }
}
```

`isRunning` needs no change — its existing exclusion list (`phase !== 'IDLE' && phase !== 'DONE' && phase !== 'ABORTED'`) already treats `BLOCKED` as running.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run tests/unit/phase.test.ts`
Expected: PASS — both tests.

- [ ] **Step 5: Typecheck**

Run: `cd extension && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add extension/src/shared/messages.ts extension/src/sidepanel/view/phase.ts extension/tests/unit/phase.test.ts
git commit -m "feat(shared): add BLOCKED task phase and antibot timeline events"
```

---

### Task 3: Wire detection and polling into the orchestrator

**Files:**
- Modify: `extension/src/agent/orchestrator.ts` (`OrchestratorOpts` interface around line 72-82; the import block around line 45-48; `autoObserveAfterNavigation`, currently at approximately line 546-609)
- Test: `extension/tests/integration/orchestrator.test.ts`

This task depends on Tasks 1 and 2 (it imports `detectAntiBotBlock` from Task 1 and uses the `'BLOCKED'` phase and `antibot.*` events from Task 2) — do not start it before both are committed.

- [ ] **Step 1: Write the failing test**

Add to `extension/tests/integration/orchestrator.test.ts`, in the same file, a new `describe` block (place it near the other `describe('orchestrator — ...')` blocks — exact position doesn't matter, this file is one flat sequence of independent describes):

```typescript
describe('orchestrator — anti-bot block detect-and-pause', () => {
  it('pauses on an anti-bot block, polls, and resumes once it clears', async () => {
    let ariaCallCount = 0;
    const registry = buildRegistry();
    registry.register({
      name: 'tab.open',
      description: 'open a tab',
      argsSchema: z.object({ url: z.string() }),
      async dispatch() {
        return { ok: true, content: 'opened', data: { tabId: 7 } };
      },
    });
    registry.register({
      name: 'aria.extract',
      description: 'read the page',
      argsSchema: z.object({ tabId: z.number() }),
      async dispatch() {
        ariaCallCount += 1;
        if (ariaCallCount <= 2) {
          return {
            ok: true,
            content: '   heading "Just a moment..."\n   text "checking your browser before accessing the site."',
            data: { url: 'https://example.com/' },
          };
        }
        return { ok: true, content: '[1] button "Continue"', data: { url: 'https://example.com/' } };
      },
    });

    const planJson = JSON.stringify({ steps: [{ description: 'open the page', successCriteria: 'opened' }] });
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: planJson })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'tab.open', args: { url: 'https://example.com' } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'done' } }] }),
      ],
    });

    const events: TimelineEvent[] = [];
    const orch = new Orchestrator({
      ollama,
      registry,
      settings: { ...DEFAULT_SETTINGS },
      emit: (e) => events.push(e),
      antiBotPollMs: 1,
    });
    const result = await orch.runUntilTerminal(await orch.start('open the page'));

    expect(result.phase).toBe('DONE');
    expect(events.some((e) => e.kind === 'antibot.blocked')).toBe(true);
    expect(events.some((e) => e.kind === 'antibot.resolved')).toBe(true);
    expect(ariaCallCount).toBeGreaterThanOrEqual(3); // 1 initial read + at least 2 polls before it clears
  });

  it('never emits antibot.blocked when the page has no block signal', async () => {
    const registry = buildRegistry();
    registry.register({
      name: 'tab.open',
      description: 'open a tab',
      argsSchema: z.object({ url: z.string() }),
      async dispatch() {
        return { ok: true, content: 'opened', data: { tabId: 7 } };
      },
    });
    registry.register({
      name: 'aria.extract',
      description: 'read the page',
      argsSchema: z.object({ tabId: z.number() }),
      async dispatch() {
        return { ok: true, content: '[1] button "Continue"', data: { url: 'https://example.com/' } };
      },
    });

    const planJson = JSON.stringify({ steps: [{ description: 'open the page', successCriteria: 'opened' }] });
    const ollama = makeFakeOllama({
      planner: [rawResponse({ content: planJson })],
      executor: [
        rawResponse({ toolCalls: [{ name: 'tab.open', args: { url: 'https://example.com' } }] }),
        rawResponse({ toolCalls: [{ name: 'finish', args: { verdict: 'success', summary: 'done' } }] }),
      ],
    });

    const events: TimelineEvent[] = [];
    const orch = new Orchestrator({
      ollama,
      registry,
      settings: { ...DEFAULT_SETTINGS },
      emit: (e) => events.push(e),
      antiBotPollMs: 1,
    });
    const result = await orch.runUntilTerminal(await orch.start('open the page'));

    expect(result.phase).toBe('DONE');
    expect(events.some((e) => e.kind === 'antibot.blocked')).toBe(false);
    expect(events.some((e) => e.kind === 'antibot.resolved')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extension && npx vitest run tests/integration/orchestrator.test.ts -t "anti-bot"`
Expected: FAIL — `antiBotPollMs` isn't a valid `OrchestratorOpts` field yet (TypeScript error), and no `antibot.blocked`/`antibot.resolved` events are ever emitted yet (the first test's assertions on them would fail even if the type error were ignored).

- [ ] **Step 3: Implement**

In `extension/src/agent/orchestrator.ts`, add the import (next to the existing `findConsentDismiss` import, currently at line 45):

```typescript
import { findConsentDismiss } from './tools/browser/consent';
import { detectAntiBotBlock } from './tools/browser/antibot';
```

Add a new optional field to `OrchestratorOpts` (currently lines 72-82):

```typescript
export interface OrchestratorOpts {
  ollama: OllamaClient;
  registry: ToolRegistry;
  settings: Settings;
  emit: (event: TimelineEvent) => void;
  signal?: AbortSignal;
  maxReplans?: number;
  maxStepTurns?: number;
  /** A pre-built plan that bypasses the planner LLM call (fast path, e.g. "Ask this page"). */
  seedPlan?: Array<{ description: string; successCriteria: string; toolHint?: string }>;
}
```

to:

```typescript
export interface OrchestratorOpts {
  ollama: OllamaClient;
  registry: ToolRegistry;
  settings: Settings;
  emit: (event: TimelineEvent) => void;
  signal?: AbortSignal;
  maxReplans?: number;
  maxStepTurns?: number;
  /** A pre-built plan that bypasses the planner LLM call (fast path, e.g. "Ask this page"). */
  seedPlan?: Array<{ description: string; successCriteria: string; toolHint?: string }>;
  /** How often to re-check for an anti-bot block clearing while paused. Default 5000ms in
   *  production; tests override this to keep the polling loop fast. */
  antiBotPollMs?: number;
}
```

Replace `autoObserveAfterNavigation`'s body (currently, verified against the file at plan-writing time):

```typescript
  private async autoObserveAfterNavigation(out: ExecutorOut, toolCtx: ToolContext): Promise<void> {
    const navigated =
      out.result.ok &&
      (NAVIGATING_TOOLS.has(out.tool) ||
        (out.tool === 'tab.type' && !!(out.args as { submit?: unknown }).submit));
    const navTabId =
      typeof (out.args as { tabId?: unknown }).tabId === 'number'
        ? (out.args as { tabId: number }).tabId
        : out.result.data && typeof out.result.data.tabId === 'number'
          ? (out.result.data.tabId as number)
          : undefined;
    if (!navigated) return;
    if (navTabId === undefined) {
      this.emit({
        kind: 'log',
        ts: Date.now(),
        level: 'warn',
        message: 'navigated but could not resolve a tabId to re-read — the next turn keeps the previous page content',
      });
      return;
    }

    await waitForTabSettled(navTabId);
    const obs = await this.opts.registry.dispatch('aria.extract', { tabId: navTabId }, toolCtx).catch(() => null);
    if (!(obs && obs.ok && obs.content)) {
      this.emit({
        kind: 'log',
        ts: Date.now(),
        level: 'warn',
        message:
          'auto-read after navigation returned no page content (page may still be loading) — the next turn has no fresh read',
      });
      return;
    }
    const obsUrl = obs.data && typeof obs.data.url === 'string' ? (obs.data.url as string) : this.lastRead?.url;
    this.lastRead = { tool: 'aria.extract', url: obsUrl, content: obs.content.slice(0, this.caps.page) };
    this.lastObserveTool = 'aria.extract'; // nudge: act on the fresh page, don't re-extract
    this.recordObserved(obs.content, obsUrl);
    this.emit({
      kind: 'log',
      ts: Date.now(),
      level: 'info',
      message: `auto-read page after navigation${obsUrl ? ` (${obsUrl})` : ''} — ${obs.content.length} chars`,
    });

    // Consent/cookie wall? Dismiss it (privacy-preferring) so the model reads the
    // real page — but only where the user upgraded this domain to act.
    const consent = findConsentDismiss(obs.content);
    if (!(consent && this.canActUrl(obsUrl))) return;
    await this.opts.registry.dispatch('tab.click', { tabId: navTabId, elementIndex: consent.index }, toolCtx).catch(() => null);
    this.emit({
      kind: 'log',
      ts: Date.now(),
      level: 'info',
      message: `dismissed consent overlay (${consent.kind}): "${consent.label}"`,
    });
    await waitForTabSettled(navTabId);
    const after = await this.opts.registry.dispatch('aria.extract', { tabId: navTabId }, toolCtx).catch(() => null);
    if (after && after.ok && after.content) {
      const afterUrl = after.data && typeof after.data.url === 'string' ? (after.data.url as string) : obsUrl;
      this.lastRead = { tool: 'aria.extract', url: afterUrl, content: after.content.slice(0, this.caps.page) };
      this.recordObserved(after.content, afterUrl);
    }
  }
```

with:

```typescript
  private async autoObserveAfterNavigation(out: ExecutorOut, toolCtx: ToolContext): Promise<void> {
    const navigated =
      out.result.ok &&
      (NAVIGATING_TOOLS.has(out.tool) ||
        (out.tool === 'tab.type' && !!(out.args as { submit?: unknown }).submit));
    const navTabId =
      typeof (out.args as { tabId?: unknown }).tabId === 'number'
        ? (out.args as { tabId: number }).tabId
        : out.result.data && typeof out.result.data.tabId === 'number'
          ? (out.result.data.tabId as number)
          : undefined;
    if (!navigated) return;
    if (navTabId === undefined) {
      this.emit({
        kind: 'log',
        ts: Date.now(),
        level: 'warn',
        message: 'navigated but could not resolve a tabId to re-read — the next turn keeps the previous page content',
      });
      return;
    }

    await waitForTabSettled(navTabId);
    let obs = await this.opts.registry.dispatch('aria.extract', { tabId: navTabId }, toolCtx).catch(() => null);
    if (!(obs && obs.ok && obs.content)) {
      this.emit({
        kind: 'log',
        ts: Date.now(),
        level: 'warn',
        message:
          'auto-read after navigation returned no page content (page may still be loading) — the next turn has no fresh read',
      });
      return;
    }
    let obsUrl = obs.data && typeof obs.data.url === 'string' ? (obs.data.url as string) : this.lastRead?.url;
    this.lastRead = { tool: 'aria.extract', url: obsUrl, content: obs.content.slice(0, this.caps.page) };
    this.lastObserveTool = 'aria.extract'; // nudge: act on the fresh page, don't re-extract
    this.recordObserved(obs.content, obsUrl);
    this.emit({
      kind: 'log',
      ts: Date.now(),
      level: 'info',
      message: `auto-read page after navigation${obsUrl ? ` (${obsUrl})` : ''} — ${obs.content.length} chars`,
    });

    // Anti-bot block (captcha/interstitial/access-denied wall)? Pause and wait for the human to
    // resolve it in the visible tab — never attempt to solve it. No timeout: this can
    // legitimately take minutes, and the existing Stop control is the escape hatch if the user
    // wants to abandon the run instead of waiting.
    let block = detectAntiBotBlock(obs.content);
    if (block) {
      this.emit({ kind: 'antibot.blocked', ts: Date.now(), label: block.label });
      await patchHot({ phase: 'BLOCKED' });
      const pollMs = this.opts.antiBotPollMs ?? 5_000;
      while (block) {
        await sleep(pollMs, this.signal);
        obs = await this.opts.registry.dispatch('aria.extract', { tabId: navTabId }, toolCtx).catch(() => null);
        if (!(obs && obs.ok && obs.content)) continue; // inconclusive read — keep polling, don't resolve
        block = detectAntiBotBlock(obs.content);
      }
      obsUrl = obs.data && typeof obs.data.url === 'string' ? (obs.data.url as string) : obsUrl;
      this.lastRead = { tool: 'aria.extract', url: obsUrl, content: obs.content.slice(0, this.caps.page) };
      this.recordObserved(obs.content, obsUrl);
      this.emit({ kind: 'antibot.resolved', ts: Date.now() });
      await patchHot({ phase: 'EXECUTING' });
      return;
    }

    // Consent/cookie wall? Dismiss it (privacy-preferring) so the model reads the
    // real page — but only where the user upgraded this domain to act.
    const consent = findConsentDismiss(obs.content);
    if (!(consent && this.canActUrl(obsUrl))) return;
    await this.opts.registry.dispatch('tab.click', { tabId: navTabId, elementIndex: consent.index }, toolCtx).catch(() => null);
    this.emit({
      kind: 'log',
      ts: Date.now(),
      level: 'info',
      message: `dismissed consent overlay (${consent.kind}): "${consent.label}"`,
    });
    await waitForTabSettled(navTabId);
    const after = await this.opts.registry.dispatch('aria.extract', { tabId: navTabId }, toolCtx).catch(() => null);
    if (after && after.ok && after.content) {
      const afterUrl = after.data && typeof after.data.url === 'string' ? (after.data.url as string) : obsUrl;
      this.lastRead = { tool: 'aria.extract', url: afterUrl, content: after.content.slice(0, this.caps.page) };
      this.recordObserved(after.content, afterUrl);
    }
  }
```

Note on abort behavior (do not change this, just be aware of it when testing): `sleep(pollMs, this.signal)` rejects with a `DOMException('Aborted', 'AbortError')` if the run is aborted (e.g. the user clicks Stop) while polling. That rejection propagates up out of `autoObserveAfterNavigation` uncaught, matching the existing `assertNotAborted()` pattern elsewhere in this file — the abort path is already handled by whatever catches that exception higher up the call stack. Don't add a try/catch around the `sleep` call that would swallow it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && npx vitest run tests/integration/orchestrator.test.ts`
Expected: PASS — the full file, including both new tests and every pre-existing test in it.

- [ ] **Step 5: Typecheck and full suite**

Run: `cd extension && npm run typecheck`
Expected: no errors.

Run: `cd extension && npm test`
Expected: all tests pass, no regressions.

- [ ] **Step 6: Commit**

```bash
git add extension/src/agent/orchestrator.ts extension/tests/integration/orchestrator.test.ts
git commit -m "feat(agent): pause on an anti-bot block and auto-resume once it clears"
```

---

## Final check

- [ ] Run `cd extension && npm run build` — expect a clean build (`tsc --noEmit && vite build`).
- [ ] Skim the final diff (`git diff a9d7d8f..HEAD` — or whatever the pre-Task-1 SHA is — for just this feature's commits) and confirm nothing outside `antibot.ts`, `antibot.test.ts`, `phase.test.ts`, `messages.ts`, `phase.ts`, and `orchestrator.ts`/`orchestrator.test.ts` was touched.
