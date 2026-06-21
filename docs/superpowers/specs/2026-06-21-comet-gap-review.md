# Honest review: our agent vs Perplexity Comet — and the gap fixes that matter

**Date:** 2026-06-21 · **Branch:** `feat/comet-gap-fixes`

## The honest verdict first

**A Chrome extension running a ~4B on-device model (gemma4:e4b) cannot out-reason or out-pace Perplexity Comet**, which is a full Chromium browser wired to frontier *cloud* models (GPT/Claude/Sonar-class). On raw reasoning depth, breadth of tasks, and especially **speed** (Comet answers in seconds; e4b is ~20–30s/turn), we lose. Pretending otherwise would be dishonest.

**Where we genuinely win — and these are durable, not catch-up:**
- **Privacy.** Everything runs on the user's machine. The page you're reading, your résumé, your goals — none of it leaves the device. Comet ships your browsing to the cloud. For a privacy-conscious user this is decisive, not a tie-breaker.
- **Cost.** Free, no subscription, no account. Comet's agentic tier is paid.
- **Honesty / grounding.** Our deterministic number-grounding gate + honest-gap prompting mean we decline what isn't on the page instead of confabulating. Frontier models are fluent *and* confidently wrong; we are slower but trustworthy.

So **"outperform Comet" honestly means: win decisively on privacy/cost/honesty, and close the UX/capability gaps that currently make us unusable for the everyday tasks Comet nails** — so a privacy-conscious user actually reaches for us.

## The gaps (evidence-based, ranked)

1. **[CRITICAL] We can't answer about the page the user is on.** The agent only reads/acts on tabs *it* opens (`ownedTabs` via `tab.open`/`open_result`). There is no path to the **active tab**. "Summarize this page", "what does this say about X", "is this claim supported?" — Comet's single most-used feature — are *impossible* today; the goal would route to web search and fail. This is the gap. **→ FIXING (flagship).**
2. **[HIGH] Latency on the common case.** Every goal runs the full planner→executor→evaluator loop (the planner alone can take up to 300s). For "just read this page and answer", that's minutes for what should be one model call. **→ FIXING: a fast path that skips the planner for page Q&A.**
3. **[MEDIUM] No citations.** Answers are grounded but never say *where* from. Comet cites. We already hold the read URLs. **→ FIXING: surface source URL(s) in the result.**
4. **[KNOWN LIMIT] Web search is anti-bot-blocked (DDG), keyless by user decree.** Open-web research is crippled. The current-tab feature sidesteps this for the most common case (you're already on the page). Truly fixing open search needs a provider/key, which is off the table. **→ Documented, not fixed.**
5. **[DEFERRED] No conversational follow-up.** Comet is a chat with cross-turn context; we're one-shot goals. A follow-up that reuses the already-read page is a natural next step. **→ Noted; out of scope this pass to ship the flagship cleanly.**

## The flagship fix — "Ask this page" (private, grounded, fast)

The same feature Comet is known for, but the page never leaves the device, the answer is grounded, and it's ~1–2 model calls instead of the full loop.

- **`tab.read_active` tool** — resolves the user's active tab (`chrome.tabs.query {active, currentWindow}`) and reads it via the existing ARIA extraction (no new tab, read-only — it's the page the user explicitly invoked on). Restricted URLs (`chrome://`, the store) return an honest "can't read this page". Also usable inside the normal loop ("find X on this page and click it").
- **Fast path** — a new `agent.askPage {question}` command seeds a fixed 1-step plan (`read the current page → answer`) and **skips the planner entirely**, cutting the slowest call. Reuses the executor + the grounding gate verbatim.
- **Citations** — the orchestrator collects the URLs it read and attaches them to the finish (`sources`); the result card shows "Source: …".
- **UI** — an "Ask about this page" mode in the composer (alongside Run / Apply), so it's a first-class action.

## Scope / discipline
- All existing SW/port contracts stay intact; `askPage` and `sources` are **additive**. The 332-test suite must stay green.
- TDD the logic: active-tab resolution + honest restricted-URL handling, the seeded-plan fast path (skips planner), source-URL collection, and the askPage view wiring; render smoke for the new UI.
- Out of scope (YAGNI this pass): conversational follow-up, a non-DDG search provider, cross-tab context.
