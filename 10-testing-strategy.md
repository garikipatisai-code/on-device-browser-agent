# 10 — Testing Strategy

## Test pyramid

```
        ┌──────┐
        │ E2E  │  ~5 tests (real browser, real Ollama)
        │      │  Run: on-demand, pre-merge gate
       ┌┴──────┴┐
       │ Integ  │  ~10 tests (orchestrator + fake Ollama)
       │        │  Run: every commit, ~100 seconds
      ┌┴────────┴┐
      │  Property │  ~25 tests (fast-check: invariants)
      │           │  Run: every commit, ~3 seconds
     ┌┴───────────┴┐
     │    Unit      │  ~200+ tests (pure functions)
     │              │  Run: every commit, ~15 seconds
     └──────────────┘
```

## Unit tests — the bulk of the suite

Test every pure function in isolation. These run in milliseconds.

```typescript
// Example: walkPlan unit test
describe('walkPlan', () => {
  it('marks current step complete, advances to next', () => {
    const plan = makePlan(3);
    const result = walkPlan(plan, plan.steps[0].id, 'done');
    expect(result.steps[0].status).toBe('completed');
    expect(result.steps[1].status).toBe('active');
  });

  it('advancing past last step marks terminal', () => {
    const plan = makePlan(1);
    const result = walkPlan(plan, plan.steps[0].id, 'done');
    expect(result.terminal).toBe(true);
  });
});
```

**What to unit test:**
- `walkPlan` — plan step transitions
- `actionHash` / `stableStringify` — deterministic serialization
- `parseJSONPermissive` — recovers JSON from prose-wrapped responses
- `circuit_breaker.*` — all breaker signals independently
- `budget.*` — token counting, truncation
- `simplifyAxTree` — ARIA node simplification
- `parseDuckDuckGoResults` — HTML parsing
- `extractProduct` / retailer adapters — product data extraction
- `redact` / `anonymize` — PII handling

## Integration tests — the orchestrator

Test the state machine with a fake Ollama client. No real model needed.

```typescript
// Pattern: scripted fake with per-role response queues
function makeFakeOllama(responses: Record<string, ChatResponse[]>) {
  return {
    chatOnce: async (opts) => {
      const role = inferRole(opts.messages);
      return responses[role]?.shift() ?? DEFAULT_RESPONSE;
    }
  };
}

describe('orchestrator', () => {
  it('completes a 3-step plan end-to-end', async () => {
    const fake = makeFakeOllama({
      planner: [planResponse],
      executor: [toolCallResponse, toolCallResponse, finishResponse],
      evaluator: [passVerdict],
      compactor: [compactionResponse],
    });
    const orch = new Orchestrator({ client: fake });
    const result = await orch.runUntilTerminal();
    expect(result.phase).toBe('DONE');
    expect(result.plan.steps.every(s => s.status === 'completed')).toBe(true);
  });

  it('goal survives replan byte-for-byte', async () => {
    const goal = 'Find a wireless mouse under $30 ★';
    const fake = makeFakeOllama({
      planner: [planResponse, replanResponse],  // First plan fails
      executor: [failToolCall, failToolCall, failToolCall], // Trip breaker
      evaluator: [failVerdict],
    });
    const orch = new Orchestrator({ client: fake, goal });
    await orch.runUntilTerminal();
    // Verify goal in hot storage matches original
    const hot = await loadHot();
    expect(hot.goal).toBe(goal);  // Byte-exact
  });
});
```

**What to integration test:**
- Full agent loop (plan → execute → evaluate → finish)
- Breaker trip → replan → successful completion
- Compaction fires when context nears budget
- Crash-resume replays events correctly
- Ollama failure mid-run transitions to ABORTED
- `clearHot` drains mutex before erasing (race condition)

## Property-based tests — invariants

Use `fast-check` to verify invariants hold for arbitrary inputs.

```typescript
// Example: actionHash is deterministic
it('actionHash is deterministic for same input', () => {
  fc.assert(fc.property(fc.string(), fc.dictionary(fc.string(), fc.anything()), (name, args) => {
    expect(actionHash(name, args)).toBe(actionHash(name, args));
  }));
});

// Example: parseJSONPermissive never crashes
it('parseJSONPermissive never throws', () => {
  fc.assert(fc.property(fc.string({ minLength: 0, maxLength: 10000 }), (input) => {
    expect(() => parseJSONPermissive(input)).not.toThrow();
  }));
});

// Example: walkPlan is immutable
it('walkPlan does not mutate input', () => {
  fc.assert(fc.property(arbitraryPlan(), (plan) => {
    const copy = JSON.parse(JSON.stringify(plan));
    walkPlan(plan, plan.steps[0].id, 'done');
    expect(plan).toEqual(copy);
  }));
});
```

**What to property test:**
- `actionHash` — key-order invariance, name discrimination, determinism
- `walkPlan` — immutability, single-step transition
- `parseJSONPermissive` — round-trip, prose tolerance, never-crashes
- Domain tier ordering — transitivity, default tier
- PII redaction — idempotency, no false positives on normal text

## Real-model integration tests (opt-in)

Gated behind `POLARIS_REAL_OLLAMA=1`. Run on the Linux box with real models.

```bash
# Fast tier (< 2 min)
POLARIS_REAL_OLLAMA=1 npm test -- --grep "fast-tier"

# Slow tier (~10 min, includes 26B Planner)
POLARIS_REAL_OLLAMA=1 npm test -- --grep "slow-tier"

# Reliability (5x smoke, expects ≥3/5 first-try tool calls)
POLARIS_REAL_OLLAMA_FLAKE_RUNS=1 npm test -- --grep "reliability"
```

## Real-browser smoke tests

Python script that drives Chrome with the extension loaded.

```python
# scripts/browser_smoke.py
# Tests:
# 1. tab.open navigates to a real page
# 2. aria.extract returns tree with content
# 3. tab.type enters text into an input
# 4. tab.click clicks a button
# 5. tab.select picks an option
# 6. Cloud round-trip (POLARIS_SMOKE_CLOUD=1)
```

**Run before merging any branch that touches browser tools or CDP code.**

## Test anti-patterns to avoid

1. **Don't mock `chrome.*` APIs inline.** Use a shared mock module so all
   tests have the same fake Chrome environment.
2. **Don't test implementation details.** Test behavior: given this state
   and these inputs, what is the output? Not: did this internal function
   get called?
3. **Don't skip slow tests in CI.** Gate them behind env vars so they're
   opt-in but not forgotten.
4. **Don't test the Ollama client's HTTP logic.** Test that your wrapper
   sends the right request shape and handles the response shape correctly.
   The actual HTTP call is Ollama's contract, not yours.

## Test file organization

```
tests/
├── unit/
│   ├── orchestrator.test.ts
│   ├── walk-plan.test.ts
│   ├── action-hash.test.ts
│   ├── parse-json.test.ts
│   ├── circuit-breaker.test.ts
│   ├── budget.test.ts
│   ├── aria.test.ts
│   ├── search-parser.test.ts
│   ├── amazon-adapter.test.ts
│   ├── redact.test.ts
│   ├── anonymize.test.ts
│   ├── domain-tiers.test.ts
│   └── state-store.test.ts
├── integration/
│   ├── orchestrator-e2e.test.ts
│   ├── crash-resume.test.ts
│   └── compaction.test.ts
├── property/
│   ├── action-hash.property.test.ts
│   ├── walk-plan.property.test.ts
│   └── parse-json.property.test.ts
└── slow/                                    # Opt-in (env var gated)
    ├── real-ollama-executor.test.ts
    ├── real-ollama-planner.test.ts
    └── executor-reliability.test.ts
```
