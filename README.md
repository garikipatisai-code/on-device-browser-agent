# On-Device Browser Agent

A goal-anchored autonomous browser agent that runs **entirely on your device** — a Chrome (MV3) extension driven by a **local LLM via [Ollama](https://ollama.com)** (default: `gemma4:e4b`). You give it a goal in plain language; it plans, reads pages, clicks/types, and reports back. No cloud, no API keys — your browsing and your data stay local.

## What it does

- **Goal → multi-step execution.** A `Planner → Executor → Evaluator → Compactor` loop decomposes a goal, acts one tool at a time, and judges progress.
- **Reads pages via the accessibility tree** (indexed, compact) — not brittle screenshots — and falls back to a vision read only when a page exposes no a11y tree.
- **Acts:** open tabs, search the web, open a result, click elements, type into fields, submit forms, scroll, attach a file to an upload field.
- **Self-improving:** records successful task flows ("workflow memory") and replays them as recipes on similar tasks.
- **Job-apply (v1):** upload a résumé (`.pdf`/`.docx`/`.txt`); the model extracts your profile to fill application form fields, and **attaches the résumé file itself** to the form. Use the **"Apply to a job"** box with a Greenhouse/Lever URL — the agent fills + attaches, then **stops before submit** for your review (it never auto-submits). See Caveats for ATS coverage.
- **Safety by default:** every site starts **read-only**; you explicitly upgrade a domain to `click-only`/`full-action` before the agent can interact. PII is redacted from logs.

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

> Behind a TLS-intercepting corporate proxy and `npm install` fails with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`? Point npm at your corp CA bundle (`npm config set cafile /path/to/corp-ca.pem`) or, as a last resort, `npm config set strict-ssl false` (npm still verifies package integrity hashes).

## Usage

1. **Settings → Models:** confirm Ollama is reachable and the models are installed (Refresh).
2. **Settings → Domain tiers:** add the site(s) you want the agent to act on and set `click-only` or `full-action`. (Unlisted sites stay read-only.)
3. *(For job-apply)* **Settings → Profile:** upload a résumé — the model fills the profile JSON; review and **Save**.
4. **Agent tab:** type a goal and **Run**, e.g.:
   - `search amazon for a wireless mouse and list the first 3 results`
   - `go to amazon.com, search for "wireless mouse", open the first product, and report its title, price, and rating`
5. **Job-apply:** after uploading your résumé (step 3), grant the ATS host `click-only` (step 2 — e.g. `boards.greenhouse.io`, `jobs.lever.co`), then use the **"Apply to a job"** box on the Agent tab: paste the posting URL → **Apply**. The agent fills the form from your profile, attaches your résumé, and stops for you to review and submit.

## Architecture

- **Service worker** (`src/background`) — owns the orchestrator and the Ollama client; kept alive across long runs (20s keepalive + a detached run loop).
- **Side panel** (`src/sidepanel`, React) — goal input, live timeline, settings, and résumé parsing (`mammoth`/`pdfjs`).
- **Agent** (`src/agent`) — roles (`planner`/`executor`/`evaluator`/`compactor`), the tool registry + browser tools (CDP-based, with command timeouts), the ARIA simplifier, workflow memory, profile, and the safety layer (domain tiers, redaction, circuit breaker).

## Development

```bash
npm run typecheck      # tsc --noEmit
npm test               # vitest (unit + integration + property)
npm run build          # production build into dist/
```

## Caveats

- **Small-model ceiling.** It runs on a ~4B local model; long interactive chains are made reliable by harness scaffolding (observe-then-act gating, auto-re-read after navigation, workflow-memory recipes) rather than raw model capability.
- **Résumé parsing is text-layer only** — a scanned/image PDF (no text) won't extract; use a text-based PDF or `.docx`.
- **Résumé file upload (job-apply)** works on standard ATS forms (Greenhouse/Lever) by injecting the stored file into the page's `<input type=file>`. Chrome blocks the on-disk CDP path (`DOM.setFileInputFiles`) for extensions, so the bytes are injected in-page via a `DataTransfer`. Not yet covered: Workday's drag-drop/direct-to-S3 uploader, and forms embedded in a cross-origin iframe. The agent fills and attaches but **never submits** — you review and submit.

## License

Personal project. No warranty.
