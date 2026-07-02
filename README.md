# On-Device Browser Agent

A goal-anchored autonomous browser agent that runs **entirely on your device** — a Chrome (MV3) extension driven by a **local LLM via [Ollama](https://ollama.com)** (default: `gemma4:e4b`). You give it a goal in plain language; it plans, reads pages, clicks/types, and reports back. No cloud, no API keys — your browsing and your data stay local.

## What it does

- **Goal → multi-step execution.** A `Planner → Executor → Evaluator → Compactor` loop decomposes a goal, acts one tool at a time, and judges progress.
- **Reads pages via the accessibility tree** (indexed, compact) — not brittle screenshots — and falls back to a vision read only when the a11y tree is too thin (e.g. a chart or image).
- **Grounded memory.** As it works it keeps a compact **facts ledger** — the key value each step established, copied verbatim from the page — and carries it into every later step, so long multi-step tasks don't forget what they found early. Final answers are **verified against what was actually read**: a number that never appeared on a page is flagged, not asserted.
- **Acts:** open tabs, search the web, open a result, click elements, type into fields, submit forms, scroll, attach a file to an upload field.
- **Capability recipes (skills).** Broad **built-in recipes** guide the model around its known weak spots — compare-and-rank, research-with-sources, verify-a-claim, live-value lookup, how-to, collect-a-list, convert/calculate, find-contact, price-across-sellers, read-visual, fill-form-without-submit, and more. **Browse, author, and edit** them in the **Recipes** tab; the agent also learns new ones from clean, successful runs (and rolls back ones that later misbehave).
- **Ask the current page.** Point it at a tab and ask a question — it answers from that page, on-device, with sources, no web search.
- **Steerable.** Redirect a run mid-flight without restarting it, and set **standing preferences** that apply to every task.
- **Job-apply (v1):** upload a résumé (`.pdf`/`.docx`/`.txt`); the model extracts your profile to fill application form fields, and **attaches the résumé file itself** to the form. Use the **"Apply to a job"** box with a Greenhouse/Lever URL — the agent fills + attaches, then **stops before submit** for your review (it never auto-submits). See Caveats for ATS coverage.
- **Safety & privacy by default:** every site starts **read-only**; you explicitly upgrade a domain to `click-only` before the agent can interact. PII is redacted before anything is logged or persisted, and nothing ever leaves your machine.
- **Optional: bypass per-site approval.** A Settings checkbox lets the agent click, type, and submit on *any* site without upgrading it domain-by-domain first — handy for one-off tasks, at the cost of no per-domain checkpoint (it can act on forms/purchases on a site you never explicitly approved). Default **off**. Even with it on, the protocol blocklist (`file:`, `chrome:`, `javascript:`, `data:`, and similar dangerous schemes) still applies — it only relaxes site-access tiers, never that.

## Requirements

- **Chrome 116+**
- **[Ollama](https://ollama.com)** running locally (`ollama serve`, default `http://localhost:11434`)
- Models pulled:
  ```
  ollama pull gemma4:e4b            # planner / executor / evaluator / compactor / vision
  ollama pull mxbai-embed-large     # embeddings
  ```
- Node 20+ for building.

## Setup

```bash
cd extension
npm install
npm run build          # tsc + vite build → extension/dist
```

Then load it in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `extension/dist`. It opens in the side panel from the toolbar.



## Usage

1. **Settings → Models:** confirm Ollama is reachable and the models are installed (Refresh).
2. **Settings → Domain tiers:** add the site(s) you want the agent to act on and set `click-only`. (Unlisted sites stay read-only. Or check the bypass box in Settings to skip per-site approval entirely — see Safety above.)
3. *(For job-apply)* **Settings → Profile:** upload a résumé — the model fills the profile JSON; review and **Save**.
4. **Agent tab:** type a goal and **Run**, e.g.:
   - `search amazon for a wireless mouse and list the first 3 results`
   - `go to amazon.com, search for "wireless mouse", open the first product, and report its title, price, and rating`
5. **Job-apply:** after uploading your résumé (step 3), grant the ATS host `click-only` (step 2 — e.g. `boards.greenhouse.io`, `jobs.lever.co`), then use the **"Apply to a job"** box on the Agent tab: paste the posting URL → **Apply**. The agent fills the form from your profile, attaches your résumé, and stops for you to review and submit.

**Also worth knowing:**

- **Ask about the page you're on.** With a tab open, ask a question about it — the agent reads that tab and answers with sources instead of web-searching.
- **Recipes tab.** Browse the built-in capability recipes, or author your own (name, when-to-use, steps — with a live preview); edit or delete your recipes anytime.
- **Steer a running task.** Type a correction while it's running to redirect it without restarting; set durable **standing preferences** in Settings to guide every task.
- **Settings → Context window (`num_ctx`).** Defaults to **32768**. For very long tasks you can raise it (`65536` → `131072`), but check `ollama ps` after each step to confirm the model still loads fully on GPU (no CPU spill) — if a task won't start or slows sharply, lower it back. A bigger window grows the agent's **cross-turn memory** (what it carries across steps); single-page reads stay focused by design.

## Architecture

- **Service worker** (`src/background`) — owns the orchestrator and the Ollama client; kept alive across long runs (20s keepalive + a detached run loop).
- **Side panel** (`src/sidepanel`, React) — goal input, live timeline, settings, and résumé parsing (`mammoth`/`pdfjs`).
- **Agent** (`src/agent`) — roles (`planner`/`executor`/`evaluator`/`compactor`), the tool registry + browser tools (CDP-based, with command timeouts), the ARIA simplifier, the grounded **facts ledger** + answer grounding-verifier (`facts.ts`), **workflow-memory recipes**, the profile, the configurable context window (`budget.ts`), and the safety layer (domain tiers, redaction, circuit breaker).

## Development

```bash
npm run typecheck      # tsc --noEmit
npm test               # vitest (unit + integration + property)
npm run build          # production build into dist/
npm run bench          # task-success benchmark (needs `ollama serve`; runs the real model)
```

`npm run bench` runs the real planner→executor→evaluator loop over scripted
multi-page fixtures and reports **completed / correct / grounded** rates. `grounded`
flags answers containing numbers that never appeared on the page — i.e. hallucinations.
Override the model or trial count with `OLLAMA_BENCH_MODEL` / `OLLAMA_BENCH_TRIALS`.

## Caveats

- **Small-model ceiling.** It runs on a ~4B local model; long interactive chains are made reliable by harness scaffolding (observe-then-act gating, auto-re-read after navigation, workflow-memory recipes) rather than raw model capability.
- **Résumé parsing is text-layer only** — a scanned/image PDF (no text) won't extract; use a text-based PDF or `.docx`.
- **Résumé file upload (job-apply)** works on standard ATS forms (Greenhouse/Lever) by injecting the stored file into the page's `<input type=file>`. Chrome blocks the on-disk CDP path (`DOM.setFileInputFiles`) for extensions, so the bytes are injected in-page via a `DataTransfer`. Not yet covered: Workday's drag-drop/direct-to-S3 uploader, and forms embedded in a cross-origin iframe. The agent fills and attaches but **never submits** — you review and submit.

## License

Personal project. No warranty.
