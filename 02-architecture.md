# 02 — Architecture

## The agent loop

```
                    ┌──────────────────────────┐
                    │   User states a goal      │
                    └────────────┬─────────────┘
                                 │
                                 ▼
                    ┌──────────────────────────┐
                    │        PLANNER            │
                    │  (thinking ON, ≤32K ctx) │
                    │  Decompose goal → steps   │
                    │  Choose first step        │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │       EXECUTOR            │
                    │  (thinking OFF, ≤6K ctx) │
                    │  Execute current step     │
                    │  Choose + call tools      │
                    │  Multiple turns per step  │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │      EVALUATOR            │
                    │  (thinking ON, ≤8K ctx)  │
                    │  Did step achieve intent? │
                    │  Verdict: pass / fail     │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │   Step complete?          │
                    │   ├─ Yes, more steps →    │
                    │   │  advance, loop back    │
                    │   │  to Executor           │
                    │   ├─ Yes, terminal →       │
                    │   │  FINISH with verdict   │
                    │   └─ No → replan           │
                    │      (max 3 replans)       │
                    └──────────────────────────┘
```

## The Compactor (implicit role)

When the Executor's context approaches its budget, a **Compactor** runs:

1. Summarizes findings so far into persistent storage (IndexedDB)
2. Truncates the scratchpad (working memory)
3. Keeps the goal, current plan step, and recent actions

The Compactor uses the same model as the Executor (fast, local). It prevents
context overflow without losing accumulated knowledge.

## State architecture

```
chrome.storage.local (hot — survives SW restart)
├── goal          : string (IMMUTABLE after set — structural guard)
├── phase         : 'IDLE' | 'PLANNING' | 'EXECUTING' | 'EVALUATING' | 'ABORTED' | 'DONE'
├── currentStepId : string
├── plan          : { steps: Step[], created: number }
├── replanCount   : number (max 3, resets on step advance)
├── ownedTabs     : number[]
└── domainTiers   : Record<string, 'read-only'|'click-only'|'full-action'>

IndexedDB (warm — larger, survives SW restart)
├── findings      : persisted extracted data
├── scratchpad    : working memory for current task
├── memory        : long-term knowledge across tasks
├── events        : audit log for crash-resume replay
└── metrics       : per-op latency + outcome telemetry
```

**Key invariant:** The `goal` field in hot state is immutable. Only the
`_setHot` private function can write it (called once on task start).
Everything else uses `patchHot` which structurally rejects goal mutations.

## Orchestrator state machine

```
IDLE ──► PLANNING ──► EXECUTING ──► EVALUATING ──► EXECUTING (next step)
  ▲                       │               │              │
  │                       │               │              │
  └─── ABORTED ◄──────────┴───────────────┴──────────────┘
  │                       (error / breaker / max replans)
  │
  └─── DONE (terminal verdict from Evaluator)
```

## Service Worker lifecycle

The Service Worker (SW) is the **orchestration host**. It:

1. Owns the Ollama client and role runners
2. Manages the state machine
3. Dispatches tool calls
4. Communicates with the side panel via `chrome.runtime.connect`

**Crash-resume:** On SW start, checks for an ABORTED or in-flight task.
If found, replays events from IndexedDB, restores hot state, and offers
the user a "Resume?" prompt.

**Watchdog:** A `chrome.alarms` alarm fires every 5 minutes. If the task's
`lastTouch` is older than that, the task is marked stale and aborted.

## Side Panel

The side panel is a React app that:

1. Renders the chat timeline (agent events, tool calls, verdicts)
2. Provides the goal input and start/stop controls
3. Shows settings (model config, domain tiers, API keys)
4. Displays metrics after a run completes

Communication: `chrome.runtime.connect` with a long-lived port.
Messages serialize state updates; the panel never mutates SW state directly.

## Why not...

### Why not LangChain / LangGraph / Mastra / Vercel AI SDK / XState?

Those frameworks target a different problem: cloud routing, multi-provider
abstraction, complex DAG orchestration. For a constrained local agent with
three roles and a simple state machine, the cost is:

- **Bundle size:** ~500 KB for a framework vs ~15 KB for custom orchestration
- **Indirection:** Framework abstractions obscure the actual prompts and tool
  calls being made — critical for debugging local model behavior
- **MV3 compatibility:** Most frameworks assume Node.js; Chrome SW has no
  `fs`, `path`, or `process.env`

The custom orchestrator is ~200 lines of TypeScript on a `phase` enum switch.

### Why not multi-agent parallel execution?

Parallel browser agents on one machine compete for: GPU VRAM (one model at a
time), CDP connections (one debugger per tab), and user attention (one side
panel). Parallelism adds complexity without throughput gains. Sequential
with compaction is the right trade-off for interactive use.
