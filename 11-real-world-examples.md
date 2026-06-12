# 11 — Real-World Agent Runs

## What a successful run looks like

### Shopping task: "Find me a wireless mouse under $30 on Amazon"

```
TURN 1 — PLANNER (gemma4:26b, thinking ON, ~45s)
┌─────────────────────────────────────────────────────────┐
│ Plan:                                                     │
│ 1. Navigate to amazon.com                                 │
│ 2. Search for "wireless mouse"                            │
│ 3. Extract product list (names + prices)                  │
│ 4. Filter to under $30                                    │
│ 5. Report top 3 with prices                               │
└─────────────────────────────────────────────────────────┘

TURN 2 — EXECUTOR (gemma4:2b, ~3s)
  Tool: tab.open({ url: "https://amazon.com" })
  → Opened tab 5

TURN 3 — EXECUTOR (gemma4:2b, ~4s)
  Tool: aria.extract({ tabId: 5 })
  → ARIA tree: search field at [1], cart at [2], nav links...

TURN 4 — EXECUTOR (gemma4:2b, ~4s)
  Tool: tab.type({ tabId: 5, elementIndex: 1, text: "wireless mouse" })
  → Typed into search field

TURN 5 — EXECUTOR (gemma4:2b, ~2s)
  Tool: tab.click({ tabId: 5, elementIndex: 1 })  // Search button
  → Search submitted, page loading...

TURN 6 — EXECUTOR (gemma4:2b, ~3s)
  Tool: tab.wait_loaded({ tabId: 5 })
  → Page loaded: "Amazon.com : wireless mouse"

TURN 7 — EVALUATOR (gemma4:4b, thinking ON, ~30s)
┌─────────────────────────────────────────────────────────┐
│ Verdict: PASS                                             │
│ Reason: Search results page loaded. URL contains          │
│ "k=wireless+mouse". Page title matches. Ready for step 3. │
└─────────────────────────────────────────────────────────┘

TURN 8 — EXECUTOR (gemma4:2b, ~6s)
  Tool: product.extract({ tabId: 5 })
  → Found 16 products. First 5:
    1. "Logitech M330 Silent Plus" — $19.99
    2. "Amazon Basics Wireless Mouse" — $12.99
    3. "Razer DeathAdder Essential" — $29.99
    ...

TURN 9 — EXECUTOR (gemma4:2b, ~2s)
  Tool: finish({
    verdict: "success",
    summary: "Found 8 wireless mice under $30. Top 3: ..."
  })
  → Task complete.
```

**Total:** 9 turns, ~95 seconds wall time. Cost: $0 (all local).

## What a replan looks like

### Scenario: The expected button isn't on the page

```
TURN 1-3 — PLANNER → EXECUTOR (navigate to site, extract page)
TURN 4 — EXECUTOR
  Tool: tab.click({ tabId: 5, elementIndex: 12 })
  → Error: elementIndex 12 not found in ARIA tree

TURN 5 — EXECUTOR
  Tool: aria.extract({ tabId: 5 })
  → ARIA tree: only 8 interactive elements. No "Checkout" button.

TURN 6 — EXECUTOR
  Tool: tab.click({ tabId: 5, elementIndex: 12 })  // Tries again
  → Error: elementIndex 12 not found

TURN 7 — EXECUTOR
  Tool: tab.click({ tabId: 5, elementIndex: 12 })  // Third attempt
  → Error: elementIndex 12 not found

TRIP — CIRCUIT BREAKER
  Signal: action-repeat (same tool+args x3)
  Action: force replan

TURN 8 — PLANNER (gets breaker reason + recent history)
┌─────────────────────────────────────────────────────────┐
│ REPLAN: The "Checkout" button doesn't exist on this page. │
│ The page is a product listing, not the cart.              │
│                                                           │
│ New step: Click the cart icon [element 3] to go to cart.  │
└─────────────────────────────────────────────────────────┘

TURN 9 — EXECUTOR
  Tool: tab.click({ tabId: 5, elementIndex: 3 })
  → Navigated to cart page.

... continues successfully
```

## What a failure looks like

### Scenario: CAPTCHA blocks the agent

```
TURN 1-5 — Normal execution: search for product
TURN 6 — EXECUTOR
  Tool: aria.extract({ tabId: 5 })
  → ARIA: "Enter the characters below", textbox "Type characters"

TURN 7 — EXECUTOR
  Tool: finish({
    verdict: "blocked",
    summary: "CAPTCHA detected on amazon.com. Cannot proceed automatically."
  })

TURN 8 — EVALUATOR
┌─────────────────────────────────────────────────────────┐
│ Verdict: FAIL                                             │
│ Reason: CAPTCHA detected. Human intervention required.    │
│ shouldReplan: false (no alternative path)                 │
└─────────────────────────────────────────────────────────┘

→ Task ABORTED. User notified: "CAPTCHA on amazon.com — solve it
  manually or try again later."
```

## What the side panel shows the user

```
┌─────────────────────────────────────┐
│ ★ Polaris                           │
│                                     │
│ Goal: Find wireless mouse under $30 │
│                                     │
│ ── TIMELINE ────────────────────────│
│                                     │
│ 🧠 Planner — created 5-step plan    │
│                                     │
│ 🔧 tab.open → amazon.com (tab 5)   │
│                                     │
│ 🔧 tab.type → "wireless mouse"      │
│                                     │
│ 🔧 tab.click → search button        │
│                                     │
│ 🔧 product.extract → 16 products    │
│                                     │
│ ✅ Evaluator — PASS (products found)│
│                                     │
│ 🔧 finish → Top 3 under $30:        │
│   1. Logitech M330 — $19.99         │
│   2. Amazon Basics — $12.99         │
│   3. Razer DeathAdder — $29.99      │
│                                     │
│ ── METRICS ─────────────────────────│
│ op          n   ok   p50    mean    │
│ planner     1   1    45s    45s     │
│ executor    5   5    3.2s   3.6s    │
│ evaluator   1   1    30s    30s     │
│                                     │
│ ✅ Task complete (95s, $0.00)       │
└─────────────────────────────────────┘
```

## What a complex multi-site task looks like

### "Compare MacBook Pro prices across Best Buy, Amazon, and B&H Photo"

```
PLAN (Planner, gemma4:26b, ~60s):
  1. Open Best Buy, search "MacBook Pro 16", extract prices
  2. Open Amazon, search "MacBook Pro 16", extract prices
  3. Open B&H Photo, search "MacBook Pro 16", extract prices
  4. Compare and report best price

EXECUTION:
  Step 1 (Best Buy): 3 turns → 3 MBP models found
  Step 2 (Amazon):   4 turns → 5 MBP models found (2 duplicates from 3rd-party)
  Step 3 (B&H):      3 turns → 2 MBP models found
  Step 4 (Compare):  1 turn  → finish with comparison table

Total: 14 turns, ~3 minutes. All local. $0 cost.
```

## Key behaviors to observe during development

1. **The agent should stop and report when stuck**, not loop endlessly.
   The circuit breaker is your safety net — if you see the same action 3
   times, the breaker should trip.

2. **The Evaluator should be strict.** If the step criteria say "find product
   names AND prices" and only names were found, the Evaluator should FAIL.
   Lenient evaluation compounds errors.

3. **The Compactor should fire before context overflow.** If the Executor
   starts producing truncated or nonsensical output, check if the context
   is too full. The Compactor should have run earlier.

4. **Tab ownership prevents tab leaks.** After a task completes, check
   `chrome.tabs.query({})` — only tabs the user opened should remain.

5. **Goal survives everything.** After any replan, compaction, or crash-resume:
   the `goal` field in hot state should be byte-identical to what the user
   typed. This is your invariant.
