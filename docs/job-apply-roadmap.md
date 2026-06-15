# Job-apply — roadmap & pending work

> Status: 2026-06-15. The **apply-to-one** slice is implemented and unit-verified on
> branch `feat/apply-to-one` (TSC clean, 201 tests, build OK). Design + plan:
> `docs/superpowers/specs/2026-06-14-apply-to-one-design.md`,
> `docs/superpowers/plans/2026-06-15-apply-to-one.md`. This file tracks what's deferred.

## 0. Deferred near-term — LIVE PROOF of apply-to-one ⏳ NOT DONE

Validate the built primitive end-to-end. Needs Ollama + Chrome, so it can't run in
the sandbox/CI — it's a manual acceptance test.

- [ ] Build + reload: `cd extension && npm run build`, then reload unpacked `extension/dist`.
- [ ] Settings → Profile: upload a real résumé; confirm the "stored" notice + the profile JSON fills.
- [ ] Settings → Domain tiers: grant `boards.greenhouse.io` and `jobs.lever.co` **`click-only`**. (Mandatory — unknown hosts default to read-only and the act tools refuse.)
- [ ] Agent → "Apply to a job": paste a real Greenhouse posting (`boards.greenhouse.io/<co>/jobs/<id>`) → **Apply**.
- [ ] Expect: text fields fill from profile · the résumé filename appears in the upload control · the agent finishes "ready for review" and does **not** submit. Repeat on a Lever posting (`jobs.lever.co/<co>/<id>`).
- [ ] If it misbehaves: capture the `[BA]` service-worker console logs + the timeline; fix on `feat/apply-to-one`.
- [ ] On pass: record the outcome to memory and merge the branch.

## 1. apply-to-one v1 — known limits & hardening (after the proof)

From the spec's out-of-scope list, plus gaps found while building:

- [ ] **Auto-submit toggle** — today it always fills-and-stops; add an opt-in to actually click submit + read the confirmation. Irreversible action — gate it carefully (per-run confirm, or a Settings switch).
- [ ] **Upload-success confirmation** — the file `<input>` is hidden, so a re-`aria.extract` can't *see* the attachment; "confirm the résumé is attached" in the recipe is therefore weak. The `tab.upload_file` result (`fileName`/`count`) is the real signal — feed it to the evaluator as evidence instead of relying on a re-read.
- [ ] **Domain-tier friction** — clicking "Apply" on a read-only host fails mid-run with a tier error. Detect the URL's host on Apply and prompt to grant `click-only` (or pre-flight-warn) instead of a cryptic failure.
- [ ] **Workday uploader** — drag-drop drop-zone + instant direct-to-S3; needs synthetic `dragenter`/`dragover`/`drop` carrying the `DataTransfer`, not just `input.files`.
- [ ] **Cross-origin iframe forms** — `Runtime.evaluate` runs top-frame only; an ATS embedded in an iframe isn't reached.
- [ ] **Multi-page / paginated applications** and **account-creation** gates.
- [ ] **Screening questions** — dropdowns, "years of experience", EEO/demographic questions; the executor fills text from profile but has no policy for these.
- [ ] **Multiple résumés / cover letter** — only one résumé is stored (IDB `resume:file`); no selection, no cover-letter attachment, and no persistent "stored: X · replace · clear" indicator in Settings.
- [ ] **`labelContains` guidance** — the upload tool can choose among multiple file inputs, but the recipe/prompt don't teach the model when to pass it.
- [ ] **Scanned/image résumés** — text-layer extraction only; no OCR, so the profile won't auto-fill from an image PDF.

## 2. Toward find-&-apply-to-many (the full pipeline)

The end goal decomposes into independent sub-projects; apply-to-one is the unit they
all reuse.

- [ ] **Broaden ATS coverage** — Ashby, SmartRecruiters, iCIMS, Taleo, Workday (the destinations that board "Apply" buttons redirect to). Lowest-risk extension of the primitive.
- [ ] **Apply-from-a-board-posting bridge** — point the agent at a posting on LinkedIn / Indeed / Dice / ZipRecruiter (paste URL or use current tab); it follows **Apply** through the redirect to the real ATS form and applies there. Meets users where they actually browse, *without* building search — works when Apply redirects to an ATS (not the native-modal case).
- [ ] **Find** — search a job source for postings → `{url, title, company}`. Gated by login walls + bot detection (LinkedIn/Indeed) + ToS.
- [ ] **Triage** — dedup / filter / rank by fit (profile vs job description) → choose which to apply to.
- [ ] **Orchestrate-many** — queue the picks, run apply-to-one on each, track applied/failed/skipped, survive SW restarts, summarize.
- [ ] **Native in-board apply** (LinkedIn "Easy Apply" / "Indeed Apply" / ZipRecruiter "1-Click") — highest reach, hardest: login + anti-bot + multi-step modals with screening questions + ToS exposure. A separate, policy-sensitive decision.

### Open verification before committing §2

- [ ] Run the per-platform research prompt (how "Apply" behaves — native vs redirect; login/anti-bot posture; ToS on automation; native-flow step count) for LinkedIn/Indeed/Dice/ZipRecruiter. Results decide ordering. Suggested sequence once apply-to-one is proven: **proof → bridge (§2.2) → broaden ATS (§2.1)**; native apply (§2.6) only after a deliberate ToS/anti-bot call.
