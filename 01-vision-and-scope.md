# 01 — Vision & Scope

## North star

Build a browser agent that can do **anything a human with a browser can do**.
Not just shopping. Any web-based task:

- Research ("Compare the top 3 frameworks for X, create a summary table")
- Forms ("Fill out this job application with my resume data")
- Monitoring ("Check this tracking page every hour, notify me if status changes")
- Data collection ("Scrape all restaurant ratings from this review site")
- Scheduling ("Book the earliest available appointment next week")
- Multi-site workflows ("Find a flight on Kayak, then check the same route on Google Flights")

## Core design principles

### 1. Goal-anchoring

The user's original goal is the **load-bearing invariant**. It lives outside model
context in persistent storage. Every planning and evaluation cycle re-injects the
goal verbatim. The agent cannot drift — even if its working context fills with
page content, the goal stays frozen.

### 2. Hierarchical execution, not flat ReAct

Flat ReAct (observe → think → act → repeat) works for simple tasks but loses
the plot on multi-step workflows. The agent uses three specialized roles:

- **Planner** (thinking ON, rare calls): Decomposes the goal into steps, makes
  strategic decisions, replans when stuck.
- **Executor** (thinking OFF, hot path): Executes the current step — chooses
  tools, interacts with pages. Fast and focused.
- **Evaluator** (thinking ON, periodic): Checks if the step achieved its intent.
  Runs after each step and before planning. Gatekeeper for quality.

### 3. Local-first, cloud-optional

Full functionality requires zero cloud configuration. All models run locally
via Ollama. Cloud API keys are an opt-in upgrade per role — not a requirement.

### 4. Read-first, act-gated

The agent can read any page. Actions (click, type, select) are **domain-tier-gated**:
each host defaults to `read-only`. The user explicitly opts a host into
`click-only` or `full-action`. The agent cannot interact with a page unless
permission was granted.

### 5. Page understanding through structure, not screenshots

Primary extraction is the **ARIA accessibility tree** — structured, semantic,
token-efficient. Vision (screenshot analysis) is a verification tool only:
"Does the page look like what the ARIA tree described?" Never the primary
extraction channel.

## What this agent is NOT

- **Not a checkout bot.** It won't complete purchases or submit payments without
  explicit per-action confirmation.
- **Not a CAPTCHA solver.** Human-in-the-loop for anti-bot challenges.
- **Not undetectable.** It uses CDP — sophisticated sites can detect automation.
- **Not multi-tab parallel.** One task at a time, one tab at a time (though it
  can open additional tabs for comparison).

## Success criteria for the implementation

1. **Goal byte-survival:** The user's exact goal text survives across replan,
   compaction, and service-worker restart. Empirically verified.
2. **Interactive latency:** Executor turns complete in ≤6 seconds (≤6K tokens
   at ~40 tok/s on local hardware).
3. **Safe by default:** The agent cannot click/type on a domain the user hasn't
   explicitly approved.
4. **Crash-resume:** Service worker death mid-task recovers to the last completed
   step, not from scratch.
5. **Online-offline:** Works fully offline (all-local models); cloud is an upgrade.
