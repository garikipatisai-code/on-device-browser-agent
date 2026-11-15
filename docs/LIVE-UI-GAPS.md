# Live UI Gaps (chrome-devtools-mcp unpacked run)

Date: 2026-11-15 (live session). Extension ID: `bpokjpibpefggbidaepahehoncfnbedh` ("On-Device Browser Agent" v0.1.0). Service worker: `sw-2` (`chrome-extension://bpok…/service-worker-loader.js`). Side panel pageId=3 (`chrome-extension://bpok…/src/sidepanel/index.html`). Content page: Wikipedia Web browser (pageId=2).

## What worked (exit 0)
- `list_pages` + `list_extensions`: initial about:blank + Polaris; post-install pages include both SWs.
- `install_extension(path="/home/appusai/Documents/Projects/on-device-browser-agent/extension/dist")` → "Extension installed. Id: bpokjpibpefggbidaepahehoncfnbedh".
- `new_page`/`navigate_page` to https://en.wikipedia.org/wiki/Web_browser → title "Web browser - Wikipedia"; snapshot RootWebArea uid=1_0; refs/links=1226; h1="Web browser".
- `evaluate_script(pageId=2, "() => document.title")` → "Web browser - Wikipedia".
- `list_console_messages(pageId=2)` → only perf issue (lazy images). `list_console_messages(pageId=2, serviceWorkerId="sw-2")` → "[BA] service worker loaded".
- `trigger_extension_action(id=bpok…)` → opened side panel (page 3 "Browser Agent").
- `take_snapshot(pageId=3)` → interactive uids: textbox "Goal" uid=2_17; button "Run" uid=2_18; tabs Settings/Recipes/Metrics; status "Missing: gemma4:e4b".
- `fill(pageId=3, uid=2_17, value="search wikipedia for Web browser and report the first heading")` succeeded; Run button clicked (uid=2_18) — request reached SW: `agent.start` + `handleStart goal=...` + `pinging Ollama ... ping result = true` + installed/missing models.
- `performance_start_trace`/`stop_trace` on pageId=2 saved `/tmp/opencode/wiki-trace.json`.
- Screenshots: `/tmp/opencode/wiki-web-browser.png`, `/tmp/opencode/sidepanel.png`, `/tmp/opencode/wiki.png`.

## What remains / gaps
- **Goal did not run**: preflight reports missing model `gemma4:e4b`. Installed Ollama models: `gemma4:e4b-it-q4_K_M`, `gemma4:e2b-it-q4_K_M`, `mxbai-embed-large:latest`. Name mismatch (expected `gemma4:e4b`). No tier upgrade attempted; no destructive Submit clicked.
- **Timeline events**: side panel stayed "Ready when you are"; no timeline events rendered (run blocked at preflight). Need model name alignment or settings override.
- **Tier upgrade**: not attempted (read-only domain tier check first; documented as gap). Do not click destructive Submit until model available.
- **File upload DataTransfer**: not exercised (no upload UI path in this run).
- **Ollama switch**: not performed (read-only `ollama list` only); model-tag mismatch must be resolved before live run.
- **Antibot pause**: not triggered (public wiki only; no antibot encountered).
- **Console args**: `get_console_message` for sw-2 msgids failed ("Request not found for selected page") because tool lacks serviceWorkerId param; installed/missing arrays not captured inline (only "[array Array]").

## Tool paths referenced
chrome-devtools-mcp: list_pages, list_extensions, install_extension, new_page, navigate_page, take_snapshot, take_screenshot, evaluate_script, list_console_messages, trigger_extension_action, fill, click, performance_start_trace, performance_stop_trace, get_network_requests.

## Vision capability check (re-run)
- `list_pages` exit 0: side panel present pageId=3; wiki pageId=2.
- Snapshot pageId=3 status: "Ready when you are" (no "Missing: gemma4:e4b" line in current snapshot; Run button uid=2_18 still present/focusable; Goal textbox uid=2_17 retains previous value).
- SW console (sw-2): same 13 messages; Ollama ping true; installed/missing model arrays not expanded (tool lacks serviceWorkerId on get_console_message). Preflight still blocks on `gemma4:e4b` mismatch (installed: `gemma4:e4b-it-q4_K_M`).
- Wiki images: `document.images.length = 12` (vision inputs available on page), so `vision.read` could be attempted if model available.
- visionModel: not `e4b-q4` in observed state; still `gemma4:e4b` expected. No full goal run forced; blocked at preflight. No tier changes, no file upload.

## Vision verdict Q4 (2026-11-15, BRAIN read-only, no pulls/secrets)
- `ollama show gemma4:e4b-it-q4_K_M` exit 0 (SHOW_E4B:0): architecture gemma4, 7.5B, Q4_K_M, Capabilities include `vision` (+completion/audio/tools/thinking), Projector clip 478.09M.
- `ollama show gemma4:e2b-it-q4_K_M` exit 0 (SHOW_E2B:0): architecture gemma4, 4.6B, Q4_K_M, Capabilities include `vision` (+completion/audio/tools/thinking), Projector clip 475.73M.
- `ollama list | grep gemma4`: `gemma4:e4b-it-q4_K_M 6.6 GB`, `gemma4:e2b-it-q4_K_M 4.6 GB` present.
- Verdict: BOTH Q4 tags are vision-capable. Vision-capable Q4 tag: `gemma4:e4b-it-q4_K_M` (primary, matches DEFAULT visionModel) and `gemma4:e2b-it-q4_K_M` (secondary). No vision gap at model level.
- Stored-settings vs defaults cause of preflight block: settings key `agent.settings` (`extension/src/background/state_store.ts` SETTINGS_KEY). `loadSettings()` merges `{ ...DEFAULT_SETTINGS, ...v }` then `migrateSettings` — stored values override new defaults. Current `DEFAULT_SETTINGS` (shared/messages.ts) already uses Q4 tags (brain `gemma4:e4b-it-q4_K_M`, body `gemma4:e2b-it-q4_K_M`, visionModel `gemma4:e4b-it-q4_K_M`), so `Missing: gemma4:e4b` comes from stale stored settings, not code defaults. No reset path in older stored record.
- Fix (no src edits here): in Settings UI set brain/vision to `gemma4:e4b-it-q4_K_M` + body to `gemma4:e2b-it-q4_K_M` (saveSettings), or reset storage (`chrome.storage.local.remove('agent.settings')` / Clear extension storage), then rebuild+reload extension so `loadSettings` returns Q4 defaults; re-run preflight.

## Q4 migration verdict (2026-11-15, BRAIN live trial)
- Extension bpok reloaded. SW sw-3, side panel page 4 Ready (Ready when you are, Run disabled, IDLE).
- Preflight: PASS (ok:true, ping true, models=[gemma4:e4b-it-q4_K_M, gemma4:e2b-it-q4_K_M, mxbai-embed-large:latest]).
- Vision seat: PRESENT (visionModel=gemma4:e4b-it-q4_K_M); Q4 tags on brain/body. Both Q4 SHOW vision/audio/tools/thinking + projector (e4b 478M, e2b 475M).
- Vision inputs: PRESENT (wiki document.images.length=12).
- Missing models: none per models.list ok:true.
- No goal run (preflight only).
- Why Q4: VRAM fit 5GB (6.6/4.6 vs 9.6/7.2 spill), text bench + Tau2 proxy looked equal; bench has zero vision tasks (blind spot, acknowledged); repo asserts gemma4 vision with no per-quant distinction — verified live now, no model-level vision loss. Breakage was stale chrome.storage agent.settings (fixed via migrateStoredModelTags).
