# Apply-to-one — design

- **Date:** 2026-06-14
- **Status:** Approved (design); ready for implementation plan
- **Scope:** First sub-project on the road to the full *find-&-apply-to-many* pipeline.

## 1. Context

The end goal is "find & apply to many jobs." That is not one feature — it is a pipeline of independent subsystems:

1. **Find** — search a job source for postings → `{url, title, company}`.
2. **Triage** — dedup / filter / rank by fit → pick which to apply to.
3. **Apply-to-one** — read one ATS form, fill from profile, attach résumé, submit/stop, confirm. ← *the atomic unit*.
4. **Orchestrate** — queue the picks, run #3 on each, track status, survive SW restarts, summarize.

`apply-to-one` is the unit the whole feature multiplies, and today it is **built but never validated on a real ATS** (the `seed-job-application` recipe and `USER PROFILE` injection exist; there has been no live test, and résumé-file upload was recorded as unsupported). Building "apply to many" on an unproven single-apply would be building on sand. So we prove and harden `apply-to-one` first.

## 2. Goal & success criteria

From a job-posting URL + the user's stored profile/résumé, the agent:
- reads the application form,
- fills the text fields from `USER PROFILE`,
- **attaches the résumé file** to the (usually hidden) file input,
- **stops before the final submit** and reports the form is ready for the user's review.

**Success = a live proof:** on one real Greenhouse posting and one real Lever posting, the text fields fill, the résumé filename appears in the form's upload control, and the agent stops without submitting.

## 3. Key decisions (with evidence)

### 3.1 Résumé upload mechanism: DataTransfer injection (path-based is dead)
Confirmed via research (Chrome/CDP behavior) + code:
- `DOM.setFileInputFiles` via `chrome.debugger` returns **`"Not allowed"`** for extensions, and even with file-URL access it needs absolute host paths the extension cannot supply from a picked `File`. → **path-based upload is not viable.**
- Working mechanism: keep the résumé **bytes**, and in the page context rebuild a `File`, assign it to the input via a `DataTransfer`, then dispatch `input` + `change` with `{bubbles:true, composed:true}`. Standard ATS uploaders read `input.files` on the event and do **not** check `event.isTrusted`.

Code facts that make this implementable today:
- `manifest.ts:23,29` — `debugger` permission + `host_permissions: ['<all_urls>']`.
- `lifecycle.ts:32` — our CDP `send` wrapper forwards **any** method string to `chrome.debugger.sendCommand` (no whitelist), so `Runtime.evaluate` / `Runtime.callFunctionOn` are available.
- `actions.ts:62,99,108,137` — we already drive the page with `Runtime.callFunctionOn` (e.g. `this.click()`), so in-page injection follows an established pattern.
- `resume.ts:28` — currently converts the picked file to **text and discards the bytes**; this must change to also retain bytes.

### 3.2 Target ATS: Greenhouse / Lever first
Clean single-page forms whose upload is the simple "hidden `<input type=file>` + `input`/`change`" mechanism. Workday (drag-drop drop-zone + instant direct-to-S3 + multi-page + account creation) is deferred.

### 3.3 Submit policy: fill-and-stop-for-review
The agent fills everything and attaches the résumé, then **stops before the final submit**. The user reviews and submits. Rationale: real applications are irreversible and the executor is a small local model; never auto-submit on the first proof. Auto-submit becomes a later toggle.

## 4. Architecture / components

### 4.1 Résumé-bytes capture & storage *(new)*
- **`SettingsPanel.tsx`** file `onChange`: in addition to the existing `extractResumeText(file) → onExtractProfile(text)` flow, read the file as base64 and emit a new `resume.store {name, mime, base64}` command. Bytes are stored regardless of whether text extraction succeeded.
- **`messages.ts`**: add `PanelCommand` `{ type: 'resume.store'; name: string; mime: string; base64: string }` and `SwUpdate` `{ type: 'resumeStored'; ok: boolean; name?: string; error?: string }`.
- **`background/index.ts`**: handle `resume.store` → `memorySet('resume:file', { name, mime, base64, savedAt })`; emit `resumeStored`. Storage is the existing IDB `memory` store (`state_store.ts:306-323`); the manifest has `unlimitedStorage`, and a base64 résumé (~1–1.5 MB) fits comfortably as one record.
- **Settings copy**: replace the "Resume file upload into a page isn't supported yet" line (`SettingsPanel.tsx:101`) with a stored-state indicator (e.g. "résumé.pdf stored — the agent can attach it").

### 4.2 `tab.upload_file` tool *(new — core capability)*
- **File:** `src/agent/tools/browser/upload.ts`.
- **Args:** `{ tabId: number; labelContains?: string }`. **No `elementIndex`** — the file input is typically `display:none`, so it is absent from the accessibility tree and cannot be handed an ARIA index. This is the reason it needs a dedicated tool rather than reusing `tab.click`/`tab.type`.
- **Tier:** `assertCanAct(url, 'click-only', ctx.settings.domainTiers)` — same gate as `tab.type`/`tab.click`. (No submit happens in v1, so `click-only` is sufficient.)
- **Mechanism:**
  1. `memoryGet('resume:file')` → bytes record. If absent → `{ ok:false, content:'No résumé stored — upload one in Settings.' }`.
  2. `withCdp(tabId, ...)`:
     - **Locate**: `Runtime.evaluate` a locator over `document.querySelectorAll('input[type=file]')` that picks the input whose associated `<label>`/nearby text matches `labelContains` (case-insensitive, defaults to matching `resume`/`cv`), else the first file input; return its `objectId` (`returnByValue:false`).
     - **Inject**: `Runtime.callFunctionOn(objectId, injector, arguments:[{value:base64},{value:name},{value:mime}])` — base64 passed as a **call argument** (not inlined into source). The injector rebuilds the `File` (`atob` → `Uint8Array` → `new File`), assigns `input.files` via a `DataTransfer`, and dispatches `input` then `change` with `{bubbles:true, composed:true}`. Returns `{ accept, name, fileName, fileInputCount }`.
  3. `clearExtractionCache(tabId)` (mirrors `actions.ts`).
  4. Result: `{ ok:true, content:'Attached <name> to the résumé field', data:{...returned...} }`.
- **Isolation / testability:** the injector function body is a pure string constant (`INJECT_FN`) and the locator a pure string constant (`LOCATE_FN`); a `buildUploadCall(...)` helper composes the `callFunctionOn` params. Unit tests assert these contain the required operations (`DataTransfer`, `input.files =`, `dispatchEvent('input')`, `dispatchEvent('change')`, honor `labelContains`) without a live page.
- **Registration:** register alongside the `actions.ts` tools, and add `tab.upload_file` to the executor's post-observation **action** tool set (the same gate that admits `tab.type`/`tab.click`).

### 4.3 `seed-job-application` recipe update (`workflow_memory.ts`)
Insert an attach step and change the tail to fill-then-stop:
- "Attach your résumé to the file-upload field — it is usually hidden, so use `tab.upload_file` (do **not** click or index a file input)."  `[tool: tab.upload_file]`
- Tail: "Do **NOT** submit. Once the fields are filled and the résumé is attached, finish and report that the form is ready for the user's review."  `[tool: finish]`

### 4.4 Executor prompt rules (`prompts/index.ts`)
- The résumé file input is usually hidden → attach it with `tab.upload_file`; never hunt a file input by index or try to click it.
- Fill-and-stop → never click the final Submit/Apply button; `finish` with a summary once the fields and résumé are done.

### 4.5 Minimal "Apply to a job" entry point (`App.tsx`, Agent tab)
A small section with a job-URL input + "Apply" button (and a "use current tab" option) that prefills a templated goal and starts the agent:

> "Apply to the job at `<url>`: read the application form, fill every field from my profile, attach my résumé using the upload tool, then STOP for my review — do not submit."

The free-text goal box remains the default for everything else. The templated goal contains `apply`/`application`/`form`/`résumé`, so it reliably matches `seed-job-application` via the existing keyword matcher (`scoreWorkflow`/`matchWorkflow`) — **no new recipe-pinning plumbing is required for v1.** This is the scoped answer to the original "narrow the user's intent" question: a task **template**, not a vague-mode dropdown, added only for the one task that needs distinct inputs.

## 5. Data flow

```
Settings: résumé pick ─┬─ extractResumeText → profile.extract → profile JSON   (existing)
                       └─ file → base64 → resume.store → memory['resume:file']  (new)

Agent tab: "Apply" (URL) → templated goal → agent.start
  Planner  → matchWorkflow → seed-job-application recipe injected
  Executor → aria.extract (read form)
           → tab.type × N  (fields ← USER PROFILE)
           → tab.upload_file  (résumé ← memory['resume:file'], DataTransfer inject)
           → aria.extract (confirm)
           → finish "ready for your review — not submitted"
```

## 6. Safety
- Fill-and-stop means the agent never submits in v1 → safe to test against real postings.
- The ATS host must be granted `click-only` by the user (same model as type/click), or the tool is refused by `assertCanAct`.

## 7. Out of scope for v1 (named, not silently dropped)
- Submitting / auto-apply (later toggle).
- Workday (drag-drop / direct-to-S3) — needs the synthetic `dragenter`/`dragover`/`drop` path.
- Forms in cross-origin iframes — `Runtime.evaluate` runs in the top frame, so an embedded ATS iframe won't be reached.
- Multi-page / paginated applications, custom screening questions, account creation.
- Finding jobs and applying to many (subsequent sub-projects #1, #2, #4).

## 8. Risks / limitations
- **Hidden vs. iframed input:** v1 targets *direct* Greenhouse/Lever postings (`boards.greenhouse.io/<co>`, `jobs.lever.co/<co>`) where the form is top-level. Company pages that embed the ATS in a cross-origin iframe are out of scope.
- **Multiple file inputs** (résumé vs. cover letter): the locator defaults to the first / the `resume`/`cv`-labelled input; `labelContains` lets the executor disambiguate.
- **Base64 size:** a normal résumé is well under CDP message limits; scanned/large PDFs are larger but still acceptable as a single `callFunctionOn` argument.
- **`isTrusted`:** research indicates standard ATS uploaders don't gate on it; if a specific form does, that form is a documented v1 miss, not a redesign.

## 9. Testing
- **Unit**
  - `buildUploadCall` / `INJECT_FN` / `LOCATE_FN`: embed bytes as an argument (not inlined), honor `labelContains`, and dispatch both `input` and `change` with `{bubbles, composed}`.
  - `resume.store` handler: base64 round-trips and persists to `memory['resume:file']`.
  - `seed-job-application`: recipe now contains the `tab.upload_file` step and the explicit fill-then-stop tail, and contains **no** submit step.
- **Live proof (acceptance):** one real Greenhouse posting + one real Lever posting → text fields fill from profile, the résumé filename shows in the upload control, and the agent stops before submit.
