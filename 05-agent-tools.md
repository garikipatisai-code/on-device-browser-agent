# 05 — Agent Tools

## Tool philosophy

Tools are the agent's hands. Every tool is:
1. **Zod-validated** — schema defines args, runtime validation catches model errors
2. **Self-describing** — JSON Schema generated from Zod for the model's `tools` array
3. **Fail-explicit** — errors are typed (`fatal` vs `retryable`), never silent
4. **Timeout-guarded** — every browser tool has a deadline; hung CDP won't hang the agent

## Tool registry pattern

```typescript
interface ToolDef {
  name: string;
  description: string;        // For the model's system prompt
  argsSchema: z.ZodTypeAny;   // Zod → JSON Schema for Ollama
  dispatch(args: any, ctx: ToolContext): Promise<ToolResult>;
}

interface ToolResult {
  ok: boolean;
  content: string;            // Human-readable result for the model
  data?: Record<string, unknown>;  // Structured data for downstream use
  fatal?: boolean;            // If true, breaker should react
  unknownTool?: boolean;      // If true, model hallucinated this tool name
}

interface ToolContext {
  taskId: string;
  signal: AbortSignal;
}
```

## Complete tool catalog

### Phase 1 — Core tools (M1-M2)

| Tool | Args | Returns | Notes |
|------|------|---------|-------|
| `echo` | `{ message: string }` | Echoed message | Sanity check |
| `next_step` | `{ reason: string }` | Advanced plan step | Advances `currentStepId` |
| `finish` | `{ verdict, summary }` | Terminal result | Ends the task |
| `memory.read` | `{ key: string }` | Stored value | Long-term memory |
| `memory.write` | `{ key, value }` | Confirmation | Long-term memory |
| `memory.list` | `{}` | All keys | Memory overview |

### Phase 2 — Browser tools (M3)

| Tool | Args | Returns | Domain Tier | Notes |
|------|------|---------|-------------|-------|
| `tab.open` | `{ url: string }` | `{ tabId }` | N/A | Registers ownership |
| `tab.close` | `{ tabId?: number }` | Confirmation | N/A | Only closes owned tabs |
| `tab.list` | `{ reason: string }` | Tab list | N/A | All open tabs |
| `tab.screenshot` | `{ tabId, width?, height? }` | PNG data-URI | N/A | ≥1200px for vision |
| `tab.wait_loaded` | `{ tabId, timeoutMs? }` | Page info | N/A | Waits for `complete` |
| `tab.dom_settle` | `{ tabId, quietMs? }` | Settle result | N/A | MutationObserver idle-wait |
| `aria.extract` | `{ tabId: number }` | Simplified ARIA tree | read-only | Primary page reading |
| `search` | `{ query: string }` | DuckDuckGo results | N/A | Parsed from DDG HTML |
| `product.extract` | `{ tabId: number }` | Product data | read-only | Routes to retailer adapter |

### Phase 3 — Page actions (gated by domain tier)

| Tool | Args | Domain Tier | Notes |
|------|------|-------------|-------|
| `tab.click` | `{ tabId, elementIndex }` | click-only+ | CDP `Input.dispatchMouseEvent` |
| `tab.type` | `{ tabId, elementIndex, text }` | click-only+ | CDP `Input.dispatchKeyEvent` + field clear |
| `tab.select` | `{ tabId, elementIndex, value }` | click-only+ | CDP + `Runtime.evaluate` for `<select>` |

### Phase 4 — Advanced (M4+)

| Tool | Args | Domain Tier | Notes |
|------|------|-------------|-------|
| `vision.ground` | `{ tabId, claim }` | read-only | Verifies ARIA extraction against screenshot |
| `tab.scroll` | `{ tabId, direction, amount }` | click-only+ | Scroll page |
| `tab.hover` | `{ tabId, elementIndex }` | click-only+ | Hover for dropdowns/tooltips |
| `memory.search` | `{ query, topK }` | N/A | Semantic search over memory |
| `page.extract` | `{ tabId }` | read-only | Full-page ARIA at 16K chars (always fresh) |

## ARIA tree extraction — the primary page reading channel

```
Raw AXTree (CDP) → simplifyAxTree() → SimplifiedNode[]
                                              │
                    ┌─────────────────────────┘
                    │
                    ▼
            Strip generic/none/presentation wrappers
            Collapse single-child chains (5-iter cap)
            Preserve: role, name, value, backendDOMNodeId
            Token-cap at configurable length (default 16K chars)
            Multi-pass leaf-trim then synthetic [truncated] marker
```

**Why ARIA, not HTML?**
- ARIA is the semantic view — already parsed, no `<div>` soup
- Token-efficient (50-80% smaller than raw HTML for the same information)
- Includes `backendDOMNodeId` for CDP action resolution
- Works on SPAs, shadow DOM, canvas-rendered content

**Why not vision as primary extraction?**
- Vision models hallucinate on small/low-res screenshots
- 1200px minimum width required for reliable vision
- Token cost: a 143 KB screenshot is ~35K tokens vs ~2K for equivalent ARIA
- Vision is verification: "Does the page look like the ARIA tree says?"

## Element indexing — bridging reading and acting

The ARIA tree assigns each interactive node an index:

```
[1] link "Wireless Mouse"      ← backendDOMNodeId: 1234
[2] button "Add to Cart"       ← backendDOMNodeId: 5678
[3] textbox "Quantity"         ← backendDOMNodeId: 9012
```

The Executor uses these indices in tool calls:
```
tab.click(tabId: 5, elementIndex: 2)   ← clicks "Add to Cart"
tab.type(tabId: 5, elementIndex: 3, text: "2")  ← types in Quantity
```

**The element cache problem:** ARIA trees go stale on navigation. Every
extraction stamps the page URL. Action tools (`click`, `type`) verify the
current tab URL matches the cached extraction's URL. Mismatch = re-extract.
`page.extract` always re-extracts (never serves cache).

## DuckDuckGo search parser

HTML-scrapes DDG result pages with regex:
```
result__a anchor → title + decoded URL (/l/?uddg=... → real URL)
result__snippet div → description text
Strips <b> highlight tags
Tolerates malformed HTML
```

DDG chosen over Google because: no CAPTCHA at moderate rates, no API key
required, HTML is simple to parse. For production, a proper search API
(SerpAPI, Brave Search) is more reliable.

## Retailer adapter framework

```typescript
interface RetailerAdapter {
  name: string;
  hostPattern: RegExp;
  extract(tree: SimplifiedNode, url: string): Product | null;
}

interface Product {
  title: string;
  price?: { amount: number; currency: string };  // Integer cents (no floats)
  inStock?: boolean;
  rating?: number;
  features?: string[];
  asin?: string;       // Amazon-specific
  url: string;
}
```

Adapters are host-matched by URL. Unknown hosts get a generic extraction
(fallback to page title + meta description). The framework is extensible —
add a new adapter file for each retailer.

**Price math in integer cents** avoids IEEE-754 floating-point issues.
`$29.99` → `{ amount: 2999, currency: "USD" }`.
