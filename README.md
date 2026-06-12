# Browser Agent Blueprint — Complete Bootstrap Kit

> **Purpose:** Give a fresh Claude Code session everything it needs to build a
> production-grade autonomous browser agent from scratch — architecture, model
> strategy, tool catalog, safety guardrails, lessons learned, and implementation
> roadmap. No tribal knowledge required.

## What you're building

A Chrome MV3 extension that turns the browser into a **goal-anchored
autonomous agent**. The user states any goal they'd open a browser to accomplish
("Find me a wireless mouse under $30 with next-day delivery", "Book a flight to
Chicago next Tuesday morning", "Fill out this multi-page tax form"), and the
agent pursues it autonomously — navigating, clicking, typing, reading pages,
comparing options — while staying locked on the original intent even as its
working context fills.

**Scope:** Everything a human with access to a browser can do. Not just shopping.
Any web-based task.

## How to use this kit

Read in order for the full picture, or jump to specific files:

| File | When to read |
|------|-------------|
| [`01-vision-and-scope.md`](./01-vision-and-scope.md) | First — understand the north star |
| [`02-architecture.md`](./02-architecture.md) | Understand the agent loop design |
| [`03-model-strategy.md`](./03-model-strategy.md) | Pick models for each role |
| [`04-technical-stack.md`](./04-technical-stack.md) | Set up the dev environment |
| [`05-agent-tools.md`](./05-agent-tools.md) | Build the tool catalog |
| [`06-prompts-and-budgets.md`](./06-prompts-and-budgets.md) | Write role prompts |
| [`07-safety-and-constraints.md`](./07-safety-and-constraints.md) | Add guardrails |
| [`08-lessons-learned.md`](./08-lessons-learned.md) | Avoid known pitfalls |
| [`09-implementation-roadmap.md`](./09-implementation-roadmap.md) | Build in the right order |
| [`10-testing-strategy.md`](./10-testing-strategy.md) | Keep it working |
| [`11-real-world-examples.md`](./11-real-world-examples.md) | See expected behavior |

## Quick orientation

**Architecture:** Hierarchical Planner → Executor → Evaluator loop (NOT flat ReAct).
The user's goal lives outside model context in persistent storage. Three specialized
roles with different models and context budgets.

**Models (current, June 2026):** Gemma 4 family via Ollama — `gemma4:2b` (fast/cheap),
`gemma4:4b` (balanced), `gemma4:26b` (reasoning). Local-first; cloud BYOK is opt-in.

**Platform:** Chrome MV3 extension — Side Panel (UI) + Service Worker (orchestration).
Tools use Chrome DevTools Protocol (CDP) for page actions. ARIA tree for page extraction.

**Safety:** Domain-tier system (read-only / click-only / full-action per host).
Circuit breaker detects loops. PII redacted at persistence boundaries.

## Prerequisites for the implementing session

- Node.js 20+, TypeScript, Vite + CRXJS (extension bundling)
- Ollama running locally with models pulled
- Chrome 148+ for MV3 side panel + CDP access
- Understanding of Chrome extension APIs (sidePanel, debugger, tabs, storage)

## Reference implementation

The Polaris project at `~/Documents/Projects/Polaris` is a working reference
implementation covering M1 (scaffold) through M3.5 (browser tools + safety).
Use it to see concrete code patterns, not as a constraint — the next build
can be cleaner.
