# 04 — Technical Stack

## Extension scaffold

```
extension/
├── src/
│   ├── manifest.ts              # MV3 manifest (permissions, CSP, content_scripts)
│   ├── background/              # Service Worker (orchestration host)
│   │   ├── index.ts             # SW entry: message handlers, orchestrator init
│   │   ├── orchestrator.ts      # State machine: runUntilTerminal()
│   │   ├── ollama.ts            # Ollama HTTP client (chat, embed, ping)
│   │   ├── signal.ts            # Manual AbortSignal + cleanup (no timer leaks)
│   │   ├── providers.ts         # Per-role model resolution (local/cloud)
│   │   ├── chat_driver.ts       # Unified chat dispatch (Ollama | Cloud)
│   │   └── state_store.ts       # chrome.storage.local + IndexedDB wrappers
│   ├── agent/                   # Agent logic (model-agnostic)
│   │   ├── roles/               # Planner, Executor, Evaluator, Compactor
│   │   │   ├── planner.ts
│   │   │   ├── executor.ts
│   │   │   ├── evaluator.ts
│   │   │   └── compactor.ts
│   │   ├── prompts/             # Role prompt templates
│   │   ├── tools/               # Tool registry + individual tools
│   │   │   ├── registry.ts      # Tool dispatch, Zod validation
│   │   │   ├── browser/         # CDP-based tools
│   │   │   │   ├── aria.ts      # ARIA tree extraction
│   │   │   │   ├── tab.ts       # Tab management
│   │   │   │   ├── actions.ts   # Click, type, select via CDP
│   │   │   │   ├── search.ts    # DDG web search
│   │   │   │   └── lifecycle.ts # CDP attach/detach, timeouts
│   │   │   └── retailers/       # Domain-specific extractors
│   │   ├── safety/              # Guardrails
│   │   │   ├── circuit_breaker.ts
│   │   │   ├── domain_tiers.ts
│   │   │   └── redact.ts        # PII redaction + anonymization
│   │   ├── budget.ts            # Token counting + budget enforcement
│   │   └── metrics.ts           # Per-op latency + success rate
│   ├── sidepanel/               # React UI
│   │   ├── App.tsx              # Main component
│   │   ├── components/          # Timeline, settings, etc.
│   │   └── styles.css
│   ├── content/                 # Content scripts
│   │   └── som.ts               # Set-of-Marks overlay (optional)
│   └── shared/                  # SW ↔ Panel message types
│       └── messages.ts
├── tests/
│   ├── unit/                    # Pure function tests
│   └── integration/             # State machine tests
├── scripts/
│   └── browser_smoke.py         # Real-browser end-to-end test
├── vite.config.ts
├── tsconfig.json
└── package.json
```

## Key dependencies

```json
{
  "devDependencies": {
    "@crxjs/vite-plugin": "^2.x",   // Chrome extension bundling
    "vite": "^6.x",
    "typescript": "^5.x",
    "vitest": "^3.x",               // Unit + integration tests
    "fast-check": "^4.x"            // Property-based testing
  },
  "dependencies": {
    "zod": "^3.x",                  // Schema validation (runtime)
    "idb": "^8.x",                  // IndexedDB wrapper
    "react": "^19.x",               // Side panel UI
    "react-dom": "^19.x"
  }
}
```

**Bundle size target:** SW < 200 KB, Panel < 200 KB. No framework SDKs.
Raw `fetch()` for Ollama and cloud APIs.

## Chrome extension manifest (critical permissions)

```typescript
// src/manifest.ts
export const manifest: ManifestV3 = {
  manifest_version: 3,
  name: "Browser Agent",
  permissions: [
    "sidePanel",      // UI surface
    "storage",         // chrome.storage.local
    "tabs",            // Tab management
    "debugger",        // CDP access (ARIA, click, type)
    "activeTab",       // Access current tab
    "alarms",          // Watchdog timer
    "unlimitedStorage" // IndexedDB for large findings
  ],
  host_permissions: ["<all_urls>"],  // Read any page
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'; base-uri 'self'"
  }
};
```

## Ollama HTTP client design

```typescript
interface OllamaClient {
  chatOnce(opts: ChatOpts): Promise<ChatResponse>;
  chatStream(opts: ChatOpts): AsyncGenerator<ChatResponse>;
  embed(input: string, opts?: EmbedOpts): Promise<number[]>;
  ping(): Promise<boolean>;
  listModels(): Promise<string[]>;
}
```

**Key behaviors:**
- `keep_alive: '10m'` on every call (keep model warm between turns)
- `composeSignal(timeoutMs)` returns `{signal, cleanup}` — manual timer with
  mandatory `cleanup()` in finally block (no `AbortSignal.timeout` leaks)
- One retry on transient HTTP 5xx + non-timeout network errors
- `AbortSignal.any([userSignal, timeoutSignal])` for cancellation
- Pre-flight ping before starting task (fail fast on wrong URL)

## Cloud client design

```typescript
interface CloudClient {
  chatOnce(opts: ChatOpts): Promise<ChatResponse>;
  chatStream(opts: ChatOpts): AsyncGenerator<ChatResponse>;
}
```

- OpenAI-compatible format (`/v1/chat/completions`)
- Raw `fetch()` — no SDK dependency
- Forwards `tools`, `response_format`, `timeoutMs`
- Normalizes `tool_calls` (parses JSON arg string)
- PII anonymize → cloud → deanonymize sandwich

## State store design

```typescript
// chrome.storage.local — hot state
interface AgentStateHot {
  goal: string;                    // IMMUTABLE
  phase: TaskPhase;
  currentStepId: string;
  plan: { steps: Step[] };
  replanCount: number;
  ownedTabs: number[];
  lastTouch: number;
}

// IndexedDB — warm/cold state
// Stores: findings, scratchpad, memory, events, metrics
```

**Safety:**
- `_hotMutex` serializes all writes (prevents race conditions)
- `patchHot` structurally rejects goal mutations
- `clearHot` drains the mutex before erasing

## Build and dev workflow

```bash
cd extension
npm install
npm run dev      # Vite dev server with HMR
npm run build    # Production build → dist/
npm test         # Vitest (mock tests, fast)
POLARIS_REAL_OLLAMA=1 npm test  # Include real-Ollama integration tests
```

Load `dist/` as unpacked extension in Chrome `chrome://extensions`.
