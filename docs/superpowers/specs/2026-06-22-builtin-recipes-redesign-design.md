# Built-in recipe redesign — capability/guardrail set

**Date:** 2026-06-22
**Status:** Approved (conversation)

## Problem
The built-in recipes `compare / research / shopping / local` are the same skeleton — *search per item → read snippet → report* — differing only by keyword. They don't *provide* anything: pure search→report is something the 4B already does (we established trivial lookups aren't even worth learning). They're redundant template clutter, not skills.

## Principle (Claude Code skills analogy)
A skill doesn't re-teach what the model can do; it **enforces a discipline / supplies a capability the model lacks**. (Claude Code's TDD skill forces RED→GREEN→REFACTOR, which the model would skip.) So a built-in recipe must be **a procedure bundled with guardrails against that task's known 4B failure mode** — observed this session:

| Failure mode | Guardrail |
|---|---|
| city/metro basis-mixing | "same measure for every item" |
| combined-query → list-page trap | "one query per item, never combined" |
| over-opening when snippet suffices | "answer from snippet; open only if it lacks the fact" |
| hallucinating absent fields (CSS-only rating) | "report only fields present; else 'not shown'" |
| giant-table extraction failure | "find the specific row; don't summarize" |
| hallucinated / missing sources | "cite the sources you actually read" |
| form auto-submit | "fill from profile, upload résumé, do NOT submit" |

A recipe earns its place only if it guards one of these.

## The 6 recipes (this redesign's proposal — more have been added since; see the current built-in set in `workflow_memory.ts`)
1. **compare-and-rank** (`seed-compare`) — *which is largest/best/cheapest; compare X vs Y vs Z*. Steps: one search per item (never combined) → read each value from snippet (open only if missing) → same basis for all → report values + winner. Guards: basis-mixing, list-page trap, over-opening, ungrounded winner.
2. **research-with-sources** (`seed-research`) — *research/explain/summarize/find info on a topic*. Steps: break into 2–4 sub-questions → one focused search each, read snippets → synthesize only from what you read → cite sources. Guards: hallucination, missing citations, over-opening.
3. **extract-page-fields** (`seed-extract`, NEW) — *report the price/rating/stock/specs of a product/page*. Steps: open the page → report only fields present as text → icon/graphic-only field → "not shown", never guess → big table: pull the specific row, don't summarize. Guards: absent-field hallucination, giant-table failure, grounding.
4. **site-search-drilldown** (`seed-onpage-site-search`, keep) — *on `<site>`, search its box and open the first result*. Guards the interactive flow (submit vs click, drill-in).
5. **fill-form-no-submit** (`seed-job-application`, keep) — *apply to a job / fill a form*. Guards invented PII, hidden file inputs, auto-submit.
6. **answer-this-page** (`seed-ask-page`, NEW) — *summarize / what does THIS page say*. Steps: read the user's active tab via `tab.read_active` (no new tab / no web search) → answer only from that page; if absent, say so. Guards: web-searching when the user means their open tab.

**Dropped:** `seed-shopping`, `seed-local` — their goals fold into compare-and-rank / research-with-sources, which carry stronger guardrails.

## Matching notes
- `compare-and-rank.requiredAny` broadened to catch shopping/ranking language (cheapest/cheap/top/under/best/most + compare/which/largest/…).
- `research-with-sources.requiredAny` catches info-seeking + local (find/recommend/where/research/explain/summarize/…).
- `answer-this-page` is distinct from the UI "Ask this page" fast-path (which seeds a plan directly, bypassing matching); this recipe handles *typed* "summarize this page" goals.
- Overlaps (e.g. "summarize") are fine — all are curated (rank 1); score decides, and ask-page's `page`/`current` keywords win for current-tab goals.

## Implementation
Edit `SEED_WORKFLOWS` in `src/agent/workflow_memory.ts`; update/extend `workflow_memory.test.ts` matching tests. Pure seed-data + keyword change — no new tools (extract uses open_result/aria.extract; ask-page uses tab.read_active, both existing). TDD.
