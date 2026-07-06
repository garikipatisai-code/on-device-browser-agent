# Form-fill batching (`tab.fill_many`) — design

## Motivation

Local LLM inference is the dominant latency cost in this architecture — per this session's own live testing against `gemma4:e4b`, a single planner or executor turn routinely takes 12-25+ seconds. The executor loop is strictly one tool call per turn (`roles/executor.ts`'s `pickToolCall` explicitly discards every tool call after the first one it finds valid, even though Ollama's function-calling API already returns `toolCalls` as an array). Filling an N-field form today costs N round-trips through that latency, even when every value is already known from `USER PROFILE` before the first field is touched.

This spec adds one narrow capability: batch multiple *already-known* text-field fills into a single tool call and a single model turn, when every field is visible in the same `CURRENT PAGE CONTENT` snapshot the model is already looking at.

## Scope

In scope — confined to a new tool in `extension/src/agent/tools/browser/actions.ts`, its registration, and a small prompt addition in `extension/src/agent/prompts/index.ts`:

1. A new `tab.fill_many` tool: fills multiple text fields (by ARIA index) in one dispatch.
2. Extracting `tab.type`'s existing per-field CDP logic (native-setter clear, the date/time/color/range type-aware branch, read-back-verify — the full 2026-07-04 tool-execution-reliability logic, not a stripped-down copy) into a shared `fillOneFieldWithSend(send, elementIndex, text, opts)` helper that takes an already-open CDP connection, so `tab.fill_many` can run every field through one shared `withCdp` instead of racing N concurrent attach/detach cycles (see Design below for why that matters). `tab.type` keeps its own single-field `withCdp` wrapper around the same helper.
3. Executor prompt guidance for when to use it vs. `tab.type`.
4. Unit tests mirroring `tests/unit/actions_readback.test.ts`'s existing pattern.

Out of scope (see Non-goals): any other action type (clicks, navigation, submission), and general/unrestricted action-sequence batching.

## Why this scope, not general batching

Multi-action batching in general — letting the model chain clicks, navigation, and submits without observing in between — was considered and rejected for now. It cuts against this project's own recurring design principle ("mechanical beats semantic for this model size," `docs/architecture-map.md` §Recurring design principles): a click can change the DOM in ways the model can't foresee before the next batched action runs against what's now stale state, and that failure mode (act on a target that existed only because of the previous action) is exactly the kind of judgment call small models are bad at.

Form-fill is the one pattern where batching is safe by construction: the fields the model is filling don't usually vanish or move just because a sibling field got a value written into it, and every field being filled is already visible in the exact page snapshot the model is reasoning from — there is no "hasn't happened yet" state to get wrong. This is also the highest-value case: it's precisely the multi-round-trip-heavy pattern (job-apply forms, contact forms) that motivated this in the first place.

## The type-lookup decision: structured array vs. reused multi-tool-call

Two ways to let the model batch fields:

- **A — a new tool, one call, an array argument.** `tab.fill_many({tabId, fields: [{elementIndex, text}, ...]})`. The model's job becomes "list the fields you see and what goes in them" — a structured-extraction shape.
- **B — reuse Ollama's existing multi-tool-call response.** `ChatResponse.toolCalls` can already hold several `tab.type` calls in one response; stop discarding everything after the first, dispatch each in sequence. No new tool, but asks the model to produce several discrete tool-call objects instead of one call with a list argument.

**Decision: A**, validated empirically before committing to it (see below) rather than picked on paper. Reusing the existing, already-hardened per-field fill logic (native-setter, read-back-verify from the 2026-07-04 tool-execution-reliability work) internally is the same either way; the difference is entirely which *output shape* the model has to produce, and that's exactly the kind of question this project tests against the real model rather than assumes.

## Empirical validation (2026-07-05, against real `gemma4:e4b`)

Ran the actual executor system prompt + a representative `tab.fill_many` tool definition against Ollama directly (matching `OllamaClient.buildBody`'s exact request shape — `tools`, `tool_choice: 'auto'`, Gemma's recommended temperature 1.0/top_p 0.95/top_k 64), across three scenarios:

- **3 known fields (name/email/phone), 6 trials**: 4/6 correctly called `tab.fill_many` with all 3 fields, correct indices, correct values, zero hallucination. The other 2/6 fell back to a single `tab.type` call — not wrong, just didn't take the batching opportunity that turn.
- **2 known fields, 1 missing from profile, 2 trials**: both attempts that batched included *only* the 2 known fields — no invented phone number. This is the safety-critical case (never fabricate a value) and it held.
- **Single-field form (negative case), 2 trials**: both correctly used plain `tab.type` — the model never reached for `tab.fill_many` when there was nothing to batch.

**Reading of this evidence:** when the model chooses to batch, the output is reliably correct — this validates Approach A's shape as something `gemma4:e4b` can produce safely. The open question is *adoption rate* (roughly 4/6 ≈ 67% in this small sample), not correctness — the current test prompt says the model "may" use `tab.fill_many`; the shipped prompt wording should be more directive ("use `tab.fill_many` when..."), and adoption is worth re-checking with that wording once implemented, informally or via `npm run bench`. No evidence of the model's *existing* tool choice (plain `tab.type`) degrading — the single-field negative case was clean both trials, so adding this tool didn't measurably confuse the model's baseline judgment.

## Design

### `tab.fill_many` tool (`actions.ts`)

```ts
export const tabFillManyTool: ToolDefDescriptor<{
  tabId: number;
  fields: Array<{ elementIndex: number; text: string }>;
}> = {
  name: 'tab.fill_many',
  description:
    'Fill MULTIPLE text fields in one call when you can see several empty fields in CURRENT PAGE CONTENT and already know every value to put in them (e.g. a multi-field form matched against USER PROFILE). Each field is filled and verified the same way tab.type does. Do NOT use this if you are unsure of a value, if fields might not all be visible yet, or for anything that also needs to submit — call tab.type individually for those.',
  argsSchema: z.object({
    tabId: z.number().int(),
    fields: z.array(z.object({
      elementIndex: z.number().int().positive(),
      text: z.string(),
    })).min(2),
  }),
  async dispatch({ tabId, fields }, ctx) {
    const url = await tabUrl(tabId);
    assertCanAct(url, 'click-only', ctx.settings.domainTiers, ctx.settings.bypassDomainTiers); // once, covers the whole batch — same tier tab.type already requires
    // ONE attach/detach for the whole batch, fields filled sequentially inside it — see the note
    // below on why this can't be per-field Promise.all.
    const results = await withCdp(tabId, async (send) => {
      const out: Array<{ ok: boolean; content: string }> = [];
      for (const f of fields) {
        out.push(await fillOneFieldWithSend(send, f.elementIndex, f.text));
      }
      return out;
    });
    const failed = results.filter((r) => !r.ok);
    return {
      ok: failed.length === 0,
      content: results
        .map((r, i) => `[${fields[i].elementIndex}] ${r.ok ? 'filled' : `FAILED: ${r.content}`}`)
        .join('\n'),
    };
  },
};
```

**Why one shared `withCdp`, not `Promise.all` over N independent calls:** `withCdp` (`lifecycle.ts`) attaches `chrome.debugger` and detaches it in a `finally` on *every* call, with no de-duplication for an already-attached tab. N concurrent `withCdp` calls on the same `tabId` would race: one call's `finally`-detach could fire while a sibling call is still mid-command, or a second attach while the first is still open could simply fail (`chrome.debugger` is exclusive per tab). This is exactly why `fillOneField`'s per-field logic needs to be split into two layers: `fillOneFieldWithSend(send, elementIndex, text, opts)` — the actual CDP command sequence, given an already-open `send` — and a thin `fillOneField(tabId, elementIndex, text, opts)` wrapper that opens its own single-field `withCdp` around it, used by `tab.type`. `tab.fill_many` opens exactly one `withCdp` for the whole batch and calls `fillOneFieldWithSend` once per field inside it, sequentially. This is also strictly *more* efficient than N attach/detach round-trips would have been, not just safer.

No `submit` option — deliberately, unlike `tab.type`. Job-apply's "never auto-submits" guarantee is prompt/recipe-enforced only, not structural (`CLAUDE.md`'s Known gaps/traps), and this tool must not add a second way to accidentally trip it. A form that needs submitting after being filled still requires a separate, explicit `tab.type(..., submit: true)` or `tab.click` call — batching never collapses fill-and-submit into one step.

**Per-field independence, not fail-fast:** every field in the array is attempted regardless of an earlier field's outcome — the `for` loop inside the shared `withCdp` never breaks/returns early on a single field's failure — a stale index at position 2 shouldn't cost the model the fields at positions 1 and 3 it could still fill correctly. The aggregate result reports every field's outcome by index, so the model has exactly what it needs to retry just the failed one(s) via a normal follow-up `tab.type` call — batching is strictly an optimization on top of the executor's existing per-turn judgment, not a replacement for it.

**Cache invalidation, dispatch, breaker, timeline:** all unchanged from how every other mutating tool already works. One `assertCanAct` check per dispatch (matching `tab.type`); the existing "invalidate the ARIA index cache after every successful mutating action" rule applies once per `tab.fill_many` call, not once per field, since it's one action from the orchestrator's perspective. The circuit breaker's exact-hash repeat-action check is unaffected (a batch's args differ call to call, same as any other tool with real arguments). One `tool.call`/`tool.result` event pair per dispatch, same as every other tool — Timeline.tsx already pretty-prints array-valued args (per the 2026-07-05 progress-meter follow-up work), so no UI change is needed.

### Prompt change (`prompts/index.ts`, executor system prompt)

Replace the existing job-apply-fill line:

> To FILL a job application: for each TEXT field, tab.type the matching value from USER PROFILE (below). Use ONLY profile values for personal data — never invent a name, email, etc.

with:

> To FILL a job application or form: use tab.fill_many when you can see 2+ empty text fields at once and know every value from USER PROFILE — one call, not one per field. Use tab.type only for a single field, or when you don't yet know every value. Use ONLY profile values for personal data — never invent a name, email, etc.

This is more directive than "may" specifically because the empirical test's shortfall was adoption, not correctness — but the exact wording here is a first attempt, not a guarantee; re-check adoption rate after shipping (informally, the same way this spec's evidence was gathered, or via `npm run bench`) and iterate on the wording if it's still not landing consistently.

## Testing

Extends `tests/unit/actions_readback.test.ts`'s existing `CdpState`-driven pattern:
- All fields succeed → aggregate `ok: true`, per-field success reported.
- One field stale/fails, others succeed → aggregate `ok: false`, the failing field's index called out by name, the others still report as filled (not blocked by the failure).
- Domain-tier gate: `read-only` tier → refused before any field is touched, same message shape `tab.type` already uses.
- Schema: a 1-field or 0-field array is rejected by `argsSchema` (the `.min(2)` — below that, `tab.type` is the right tool and this one shouldn't be reachable).

## Non-goals

- **General action-sequence batching** (clicks, navigation, submits, or any mix). Explicitly deferred — see "Why this scope, not general batching" above. Revisit only with its own empirical validation if a concrete need shows up.
- **Combining fill with submit in one call.** No `submit` option on this tool, ever, without a separate design + explicit re-confirmation of the job-apply submit-guard's current (prompt-only) enforcement — see Design above.
- **Batching across a navigation.** Every field in one `tab.fill_many` call must already be visible in the current page snapshot; this tool never opens, clicks through to, or waits for a new page itself.
