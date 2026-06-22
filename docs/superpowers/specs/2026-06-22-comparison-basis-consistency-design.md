# Comparison basis-consistency — anchor on one source

**Date:** 2026-06-22
**Status:** Approved (conversation)

## Problem

When the on-device 4B agent (gemma4:e4b) compares a metric across several named items, it mixes incompatible *bases* and reaches a wrong conclusion. Live evidence — goal *"Compare the current population of Tokyo, Delhi, Shanghai, São Paulo, and Mexico City, and tell me which is largest"*:

| City | Reported | Basis | Source it came from |
|---|---|---|---|
| Tokyo | 10,316,210 | city proper | worldpopulationreview |
| Mexico City | 9,020,812 | city proper | worldpopulationreview |
| Delhi | 26,495,000 | urban agglomeration | citypopulationdata |
| Shanghai | 24,722,254 | municipality | worldpopulationreview |
| São Paulo | 23,169,000 | **metro area** | macrotrends |

The agent answered "Delhi is largest" — comparing Tokyo's *city* figure against Delhi's *agglomeration* figure. On any consistent basis it's wrong: on a metro basis Tokyo (~37 M) wins, and `36,954,000` was in the Tokyo search results the agent saw. For São Paulo it even **skipped** the #1 worldpopulationreview city figure to grab the #2 macrotrends metro figure.

The facts ledger and grounding worked perfectly (all five figures were retained across ~4 min and verified against pages read). This is purely an **upstream value-selection** failure.

## Root cause

Guidance to keep bases consistent **already exists in two places** and the model ignored both:
- `seed-compare` step 3 (`workflow_memory.ts:186`): *"Use the SAME basis for every item … never mix bases."*
- Executor rule (`prompts/index.ts:122`): *"use each city's own city-proper figure … do NOT compare one city's metro-area figure to another's."*

The reason it fails: the agent pulls each item's number from a **different source's snippet**, and judging *"is this snippet number city-proper or metro?"* across heterogeneous sources is exactly the semantic call a 4B is unreliable at. More prose of the same kind won't fix what two prose rules already failed to.

## Principle

For a 4B, **mechanical beats semantic.** Make basis-consistency a procedure the model can mechanically follow — *use the same source for every item* — rather than a judgment it must make. Same site → same basis, automatically, with no per-snippet reasoning. Source-agnostic (no site names in code).

## The procedure (anchor on one source)

1. **Item 1 sets the anchor.** Search `"<item1> <metric>"`, take its figure, and note the **source domain** it came from — the *anchor source*.
2. **Items 2…N match the anchor.** For each, search `"<item> <metric>"` and use the figure from **that same anchor domain** (open that result if the snippet doesn't show it). Do NOT take a different site's number even if it ranks higher or is a bigger/cleaner figure.
3. **Gap fallback.** If the anchor source has no figure for an item after a focused search, switch to a source that covers **all** items and re-gather the ones already collected from that source (consistency over saved turns). If no single source covers all, report each with its source labeled and call the comparison approximate.
4. **Report the basis.** State the anchor source and what its figure represents (e.g. *"city population per worldpopulationreview"*), list all items with values, and name the winner.

### Failure mode → guardrail

| Failure mode (observed) | Guardrail |
|---|---|
| each item's figure pulled from a different site → mixed bases | anchor on item 1's source; fetch every other item from that same domain |
| picks a bigger/higher-ranked number from a different source (São Paulo metro over the city figure present) | "use the anchor domain's figure even if another ranks higher / looks bigger" |
| silently swaps basis when a source lacks an item | explicit gap fallback: switch source for ALL, or label as approximate |
| user can't tell what basis was used | answer states the anchor source + what its figure represents |

## Scope & where it lives

- **`seed-compare` steps** (`src/agent/workflow_memory.ts`) — rewritten to the 4-step anchor procedure. (Matching/`requiredAny`/`goalKeywords` unchanged — only step *content* changes, so routing is unaffected.)
- **Executor comparison rules** (`src/agent/prompts/index.ts`) — the `:122` "prefer city-proper" *semantic* rule is **replaced** by the same-source *mechanical* rule; the `:81` multi-item rule gains "from the same source as the other items." Same-source naturally lands on a sensible basis, so the city-proper hint is no longer needed.
- General to any cross-item metric (population, GDP, price, specs) — not city-specific.

## Explicitly NOT doing

- **Code enforcement via the ledger's per-fact `url`** (flag a comparison whose figures span >1 domain). Rejected: for snippet-only items the agent never opens a page, so `this.lastRead.url` holds a *different* item's page — the url is unreliable as a source signal. A fragile check is worse than none; the procedure + stating the source is the honest fix.
- **Forcing a specific basis** (always city-proper). That's the semantic approach the model already fails; same-source supersedes it.
- Re-architecting search/snippet handling. Out of scope.

## Testing & validation

- **Unit:** the built-in routing matrix stays green (content-only change). Add an assertion that `seed-compare`'s steps encode the same-source procedure (e.g. mention "same source"/"anchor"). Optionally assert the executor comparison rule string contains the same-source instruction.
- **Real proof (live):** re-run the 5-city task. Expect all five figures from **one** source, a consistent ranking (Tokyo or Shanghai depending on that source's basis), and the source stated in the answer. This change is a recipe + prompt rewrite — its validation is the live re-run, not a unit test.

## Implementation notes

TDD where it applies (the matching/content assertions); branch per change → ff-merge. No new tools, no new code paths, `num_ctx` and the ledger untouched. If the 4B still drifts after this, the next escalation is genuine code enforcement (which would require reliably capturing each item's source — e.g. opening the anchor page per item so the ledger url is trustworthy).
