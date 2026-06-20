# Apply-to-one Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the agent fill a Greenhouse/Lever job application from the user's profile, attach the stored résumé file, and stop before submit for the user to review.

**Architecture:** The résumé file's bytes are captured in the side panel and stored (base64) in IndexedDB. A new `tab.upload_file` tool reconstructs the `File` in-page and assigns it to the (usually hidden) `<input type=file>` via a `DataTransfer` + `input`/`change` events — because `DOM.setFileInputFiles` is blocked for extensions. The `seed-job-application` recipe and executor prompt drive fill → attach → stop. A minimal "Apply to a job" entry point on the Agent tab turns a job URL into the recipe-matching goal.

**Tech Stack:** TypeScript, Chrome MV3 (`chrome.debugger`/CDP), React 18, Zod, idb, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-14-apply-to-one-design.md`

**Build/test commands** (corp Mac — use the nvm Node 24 full path):
- Typecheck: `~/.nvm/versions/node/v24.16.0/bin/node node_modules/typescript/bin/tsc --noEmit`
- Tests: `~/.nvm/versions/node/v24.16.0/bin/node node_modules/vitest/vitest.mjs run`
- Build: `~/.nvm/versions/node/v24.16.0/bin/node node_modules/vite/bin/vite.js build`

All commands run from `extension/`. Commit on a feature branch (`feat/apply-to-one`); do not push.

---

## File structure

- **Create** `src/agent/tools/browser/upload.ts` — the `tab.upload_file` tool + its pure in-page function strings and param builders.
- **Create** `src/sidepanel/file_bytes.ts` — `fileToBase64` (kept out of `resume.ts` so tests don't pull in the pdfjs `?url` import).
- **Create** `src/sidepanel/apply.ts` — `buildApplyGoal(url)`.
- **Modify** `src/shared/messages.ts` — add `resume.store` command + `resumeStored` update.
- **Modify** `src/background/state_store.ts` — `ResumeFile` type + `saveResumeFile`/`loadResumeFile`.
- **Modify** `src/background/index.ts` — handle `resume.store`.
- **Modify** `src/agent/tools/index.ts` — register `tabUploadFileTool`.
- **Modify** `src/agent/workflow_memory.ts` — update `seed-job-application` steps (attach + no-submit).
- **Modify** `src/agent/prompts/index.ts` — executor rules (upload + no-submit).
- **Modify** `src/sidepanel/components/SettingsPanel.tsx` — capture bytes on file pick; update copy.
- **Modify** `src/sidepanel/App.tsx` — wire `resume.store`/`resumeStored`; add the "Apply to a job" entry point.
- **Create** tests: `tests/unit/resume_store.test.ts`, `tests/unit/upload.test.ts`, `tests/unit/upload_dispatch.test.ts`, `tests/unit/file_bytes.test.ts`, `tests/unit/apply.test.ts`, `tests/unit/prompts_executor.test.ts`.
- **Modify** test: `tests/unit/workflow_memory.test.ts` (assert the new recipe shape).

---

## Task 1: Message contract + résumé storage

**Files:**
- Modify: `src/shared/messages.ts` (PanelCommand ~line 89-99, SwUpdate ~line 112-121)
- Modify: `src/background/state_store.ts` (after the memory helpers, ~line 323)
- Test: `tests/unit/resume_store.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/unit/resume_store.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { loadResumeFile, memorySet, saveResumeFile } from '@/background/state_store';
import { resetStorage } from '../helpers';

describe('résumé file storage', () => {
  beforeEach(async () => {
    await resetStorage();
  });

  it('round-trips a stored résumé file', async () => {
    expect(await loadResumeFile()).toBeNull();
    await saveResumeFile({ name: 'resume.pdf', mime: 'application/pdf', base64: 'QUJD' });
    const got = await loadResumeFile();
    expect(got?.name).toBe('resume.pdf');
    expect(got?.mime).toBe('application/pdf');
    expect(got?.base64).toBe('QUJD');
    expect(typeof got?.savedAt).toBe('number');
  });

  it('returns null when the stored value lacks bytes', async () => {
    await memorySet('resume:file', { name: 'x.pdf' });
    expect(await loadResumeFile()).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `~/.nvm/versions/node/v24.16.0/bin/node node_modules/vitest/vitest.mjs run tests/unit/resume_store.test.ts`
Expected: FAIL — `loadResumeFile`/`saveResumeFile` are not exported.

- [ ] **Step 3: Add the storage helpers**

In `src/background/state_store.ts`, after `memoryList` (~line 332), add:
```ts
// ---------- Résumé file (warm; base64 bytes for in-page upload) ----------

export interface ResumeFile {
  name: string;
  mime: string;
  base64: string;
  savedAt: number;
}

const RESUME_KEY = 'resume:file';

export async function saveResumeFile(f: { name: string; mime: string; base64: string }): Promise<void> {
  await memorySet(RESUME_KEY, { ...f, savedAt: Date.now() });
}

export async function loadResumeFile(): Promise<ResumeFile | null> {
  const v = await memoryGet(RESUME_KEY);
  if (v && typeof v === 'object' && typeof (v as ResumeFile).base64 === 'string') {
    return v as ResumeFile;
  }
  return null;
}
```

- [ ] **Step 4: Add the message types**

In `src/shared/messages.ts`, add to the `PanelCommand` union (after the `profile.extract` line):
```ts
  | { type: 'resume.store'; name: string; mime: string; base64: string }
```
And to the `SwUpdate` union (after the `profileExtracted` line):
```ts
  | { type: 'resumeStored'; ok: boolean; name?: string; error?: string }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `~/.nvm/versions/node/v24.16.0/bin/node node_modules/vitest/vitest.mjs run tests/unit/resume_store.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/shared/messages.ts src/background/state_store.ts tests/unit/resume_store.test.ts
git commit -m "feat: store résumé bytes + resume.store message contract"
```

---

## Task 2: `tab.upload_file` — pure in-page functions + param builders

**Files:**
- Create: `src/agent/tools/browser/upload.ts`
- Test: `tests/unit/upload.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/unit/upload.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { INJECT_FN, LOCATE_FN, buildInjectParams, buildLocateExpression } from '@/agent/tools/browser/upload';

describe('buildLocateExpression', () => {
  it('JSON-escapes the label into an immediately-invoked locator call', () => {
    expect(buildLocateExpression('resume')).toBe(`(${LOCATE_FN})("resume")`);
  });
  it('defaults to an empty-string argument and escapes quotes', () => {
    expect(buildLocateExpression()).toBe(`(${LOCATE_FN})("")`);
    expect(buildLocateExpression('a"b')).toContain('"a\\"b"');
  });
});

describe('buildInjectParams', () => {
  it('passes the bytes as a call ARGUMENT, not inlined into the source', () => {
    const p = buildInjectParams('obj-1', { base64: 'QUJD', name: 'r.pdf', mime: 'application/pdf' });
    expect(p.functionDeclaration).toBe(INJECT_FN);
    expect(p.functionDeclaration).not.toContain('QUJD');
    expect(p.arguments).toEqual([{ value: 'QUJD' }, { value: 'r.pdf' }, { value: 'application/pdf' }]);
    expect(p.returnByValue).toBe(true);
    expect(p.objectId).toBe('obj-1');
  });
});

describe('the in-page function strings', () => {
  it('LOCATE_FN targets file inputs and prefers résumé/cv', () => {
    expect(LOCATE_FN).toContain("querySelectorAll('input[type=file]')");
    expect(LOCATE_FN).toContain('resume');
    expect(LOCATE_FN).toContain('cv');
  });
  it('INJECT_FN sets files via DataTransfer and fires input + change (bubbling, composed)', () => {
    expect(INJECT_FN).toContain('DataTransfer');
    expect(INJECT_FN).toContain('this.files=dt.files');
    expect(INJECT_FN).toContain("dispatchEvent(new Event('input'");
    expect(INJECT_FN).toContain("dispatchEvent(new Event('change'");
    expect(INJECT_FN).toContain('composed:true');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `~/.nvm/versions/node/v24.16.0/bin/node node_modules/vitest/vitest.mjs run tests/unit/upload.test.ts`
Expected: FAIL — module `upload.ts` does not exist.

- [ ] **Step 3: Create `upload.ts` with the pure pieces**

`src/agent/tools/browser/upload.ts`:
```ts
// Attach the stored résumé file to a page's <input type=file>.
//
// The file input on most ATS forms (Greenhouse/Lever) is display:none, so it is
// absent from the accessibility tree and cannot be targeted by ARIA index like
// the other actions. And chrome.debugger's DOM.setFileInputFiles is blocked for
// extensions ("Not allowed"). So we inject in-page: rebuild a File from the
// stored bytes, assign input.files via a DataTransfer, and fire input + change —
// the approach real automation uses when it only has bytes, not a file path.

import { z } from 'zod';
import type { ToolDefDescriptor } from '../registry';
import { withCdp } from './lifecycle';
import { assertCanAct } from '@/agent/safety/domain_tiers';
import { clearExtractionCache } from './aria_tool';
import { loadResumeFile } from '@/background/state_store';

// Runs IN THE PAGE. Returns the file input to use: the one whose label/name/aria
// matches `label` if given, else the résumé/cv one, else the first. null if none.
export const LOCATE_FN = `function(label){
  var inputs = Array.prototype.slice.call(document.querySelectorAll('input[type=file]'));
  if(!inputs.length){ return null; }
  function text(el){
    var t='';
    if(el.id){ var l=document.querySelector('label[for="'+el.id+'"]'); if(l){ t+=' '+l.textContent; } }
    var p=el.closest('label'); if(p){ t+=' '+p.textContent; }
    t+=' '+(el.name||'')+' '+(el.getAttribute('aria-label')||'');
    return t.toLowerCase();
  }
  var want=(label||'').toLowerCase();
  if(want){ for(var i=0;i<inputs.length;i++){ if(text(inputs[i]).indexOf(want)>=0){ return inputs[i]; } } }
  for(var j=0;j<inputs.length;j++){ var s=text(inputs[j]); if(s.indexOf('resume')>=0||s.indexOf('cv')>=0){ return inputs[j]; } }
  return inputs[0];
}`;

// Runs IN THE PAGE bound to the located input (this). Rebuilds the File from
// base64 and attaches it via DataTransfer, then fires input + change.
export const INJECT_FN = `function(b64, name, mime){
  var bin=atob(b64); var len=bin.length; var bytes=new Uint8Array(len);
  for(var i=0;i<len;i++){ bytes[i]=bin.charCodeAt(i); }
  var file=new File([bytes], name, { type: mime });
  var dt=new DataTransfer(); dt.items.add(file);
  this.files=dt.files;
  this.dispatchEvent(new Event('input', { bubbles:true, composed:true }));
  this.dispatchEvent(new Event('change', { bubbles:true, composed:true }));
  return { name:(this.name||''), accept:(this.getAttribute('accept')||''), fileName:(this.files[0]?this.files[0].name:''), count:this.files.length };
}`;

export function buildLocateExpression(labelContains?: string): string {
  return `(${LOCATE_FN})(${JSON.stringify(labelContains ?? '')})`;
}

export interface InjectParams {
  objectId: string;
  functionDeclaration: string;
  arguments: Array<{ value: string }>;
  returnByValue: boolean;
}

export function buildInjectParams(
  objectId: string,
  resume: { base64: string; name: string; mime: string },
): InjectParams {
  return {
    objectId,
    functionDeclaration: INJECT_FN,
    arguments: [{ value: resume.base64 }, { value: resume.name }, { value: resume.mime }],
    returnByValue: true,
  };
}
```

> Note: `LOCATE_FN` matches `cv` as a substring, which also covers `résumé`'s ASCII fallbacks; the explicit `résumé` accent form is intentionally omitted to keep the match ASCII-safe.

- [ ] **Step 4: Run the test to verify it passes**

Run: `~/.nvm/versions/node/v24.16.0/bin/node node_modules/vitest/vitest.mjs run tests/unit/upload.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools/browser/upload.ts tests/unit/upload.test.ts
git commit -m "feat: upload.ts in-page DataTransfer injection (pure pieces)"
```

---

## Task 3: `tab.upload_file` dispatch + registration

**Files:**
- Modify: `src/agent/tools/browser/upload.ts` (append the tool)
- Modify: `src/agent/tools/index.ts:21-26` (import) and `:48-52` (register)
- Test: `tests/unit/upload_dispatch.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/unit/upload_dispatch.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tabUploadFileTool } from '@/agent/tools/browser/upload';
import { saveResumeFile } from '@/background/state_store';
import { resetStorage } from '../helpers';
import type { ToolContext } from '@/agent/tools/registry';

function ctx(): ToolContext {
  return {
    taskId: 't',
    signal: new AbortController().signal,
    hot: {} as never,
    settings: { domainTiers: { 'jobs.lever.co': 'click-only' } } as never,
    ollama: {} as never,
    emit: () => {},
    addFinding: async () => {},
  };
}

function mockChrome(sendImpl: (method: string) => unknown) {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: { get: (_id: number, cb: (t: { url: string }) => void) => cb({ url: 'https://jobs.lever.co/acme/1' }) },
    debugger: {
      attach: (_t: unknown, _v: unknown, cb: () => void) => cb(),
      detach: (_t: unknown, cb: () => void) => cb(),
      sendCommand: (_t: unknown, method: string, _p: unknown, cb: (r?: unknown) => void) => cb(sendImpl(method)),
    },
    runtime: { lastError: undefined },
  };
}

describe('tab.upload_file dispatch', () => {
  beforeEach(async () => {
    await resetStorage();
  });
  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it('fails clearly when no résumé is stored', async () => {
    mockChrome(() => ({}));
    const r = await tabUploadFileTool.dispatch({ tabId: 1 }, ctx());
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/no résumé stored/i);
  });

  it('attaches the résumé when a file input is found', async () => {
    await saveResumeFile({ name: 'r.pdf', mime: 'application/pdf', base64: 'QUJD' });
    mockChrome((method) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'obj-1', subtype: 'node' } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: { fileName: 'r.pdf', count: 1, accept: '.pdf' } } };
      return {};
    });
    const r = await tabUploadFileTool.dispatch({ tabId: 1 }, ctx());
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ fileName: 'r.pdf', count: 1 });
  });

  it('fails when there is no file input on the page', async () => {
    await saveResumeFile({ name: 'r.pdf', mime: 'application/pdf', base64: 'QUJD' });
    mockChrome((method) => {
      if (method === 'Runtime.evaluate') return { result: { subtype: 'null' } };
      return {};
    });
    const r = await tabUploadFileTool.dispatch({ tabId: 1 }, ctx());
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/no <input type=file>/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `~/.nvm/versions/node/v24.16.0/bin/node node_modules/vitest/vitest.mjs run tests/unit/upload_dispatch.test.ts`
Expected: FAIL — `tabUploadFileTool` is not exported.

- [ ] **Step 3: Append the tool to `upload.ts`**

Add to the end of `src/agent/tools/browser/upload.ts`:
```ts
async function tabUrl(tabId: number): Promise<string> {
  return new Promise((resolve) => chrome.tabs.get(tabId, (t) => resolve(t?.url ?? '')));
}

export const tabUploadFileTool: ToolDefDescriptor<{ tabId: number; labelContains?: string }> = {
  name: 'tab.upload_file',
  description:
    "Attach the user's stored résumé to a file-upload field. The file input is usually hidden (display:none) and has NO ARIA index — call this with just tabId (optionally labelContains to choose among several upload fields). Do NOT use tab.click for file uploads. Requires click-only tier.",
  argsSchema: z.object({
    tabId: z.number().int(),
    labelContains: z.string().optional(),
  }),
  async dispatch({ tabId, labelContains }, ctx) {
    const url = await tabUrl(tabId);
    assertCanAct(url, 'click-only', ctx.settings.domainTiers);
    const resume = await loadResumeFile();
    if (!resume) {
      return { ok: false, content: 'No résumé stored. Upload one in Settings → Profile first.' };
    }
    const data = await withCdp(tabId, async (send) => {
      const located = await send<{ result?: { objectId?: string; subtype?: string } }>('Runtime.evaluate', {
        expression: buildLocateExpression(labelContains),
        returnByValue: false,
      });
      const objectId = located.result?.objectId;
      if (!objectId || located.result?.subtype === 'null') return null;
      const injected = await send<{ result?: { value?: Record<string, unknown> } }>(
        'Runtime.callFunctionOn',
        buildInjectParams(objectId, resume) as unknown as Record<string, unknown>,
      );
      return injected.result?.value ?? {};
    });
    clearExtractionCache(tabId);
    if (data === null) {
      return {
        ok: false,
        content: 'No <input type=file> found on this page (it may be inside an iframe, which is unsupported in v1).',
      };
    }
    return { ok: true, content: `Attached résumé "${resume.name}" to the upload field.`, data: data as Record<string, unknown> };
  },
};
```

- [ ] **Step 4: Register the tool**

In `src/agent/tools/index.ts`, add the import after the `actions` import block (~line 26):
```ts
import { tabUploadFileTool } from './browser/upload';
```
And in `buildRegistry`, in the "browser — act" section (after `r.register(tabScrollTool);`, ~line 52):
```ts
  r.register(tabUploadFileTool);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `~/.nvm/versions/node/v24.16.0/bin/node node_modules/vitest/vitest.mjs run tests/unit/upload_dispatch.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/agent/tools/browser/upload.ts src/agent/tools/index.ts tests/unit/upload_dispatch.test.ts
git commit -m "feat: tab.upload_file tool + registration"
```

---

## Task 4: Recipe + executor prompt (attach résumé, never submit)

**Files:**
- Modify: `src/agent/workflow_memory.ts:118-125` (the `seed-job-application` steps)
- Modify: `src/agent/prompts/index.ts:87` (executor form-fill rule)
- Test: `tests/unit/workflow_memory.test.ts` (add a case), `tests/unit/prompts_executor.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/workflow_memory.test.ts` inside the `describe('matchWorkflow', ...)` block (or a new describe):
```ts
  it('the job recipe attaches the résumé via tab.upload_file and never submits', () => {
    const wf = SEED_WORKFLOWS.find((w) => w.id === 'seed-job-application')!;
    const hints = wf.steps.map((s) => s.toolHint ?? '');
    expect(hints).toContain('tab.upload_file');
    expect(JSON.stringify(wf.steps).toLowerCase()).toContain('do not submit');
    expect(hints.some((h) => h.includes('submit:true'))).toBe(false);
  });
```

Create `tests/unit/prompts_executor.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildExecutorMessages } from '@/agent/prompts';

describe('executor prompt — job application rules', () => {
  it('instructs résumé upload via the tool and forbids submitting', () => {
    const msgs = buildExecutorMessages({
      goal: 'apply to a job',
      toolCatalog: '',
      plan: null,
      currentStepId: null,
      ownedTabs: [],
    });
    const sys = msgs[0].content;
    expect(sys).toContain('tab.upload_file');
    expect(sys).toMatch(/do not submit/i);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `~/.nvm/versions/node/v24.16.0/bin/node node_modules/vitest/vitest.mjs run tests/unit/workflow_memory.test.ts tests/unit/prompts_executor.test.ts`
Expected: FAIL — recipe has no `tab.upload_file` step; prompt has no upload/no-submit text.

- [ ] **Step 3: Update the recipe**

In `src/agent/workflow_memory.ts`, replace the `steps` array of the `seed-job-application` workflow (lines 118-125) with:
```ts
    steps: [
      { instruction: 'Open the job application page (from the goal, or open_result of a search).', toolHint: 'tab.open / open_result' },
      { instruction: 'Read the application form and its input fields.', toolHint: 'aria.extract' },
      { instruction: 'Fill each TEXT field by typing the matching value from USER PROFILE (name, email, phone, etc.).', toolHint: 'tab.type' },
      { instruction: 'Attach your résumé to the upload field — it is usually hidden, so use tab.upload_file (do NOT click or index a file input).', toolHint: 'tab.upload_file' },
      { instruction: 'Re-read the form to confirm the fields are filled and the résumé is attached (auto-refreshed after typing).', toolHint: 'aria.extract' },
      { instruction: 'Do NOT submit. Report that the form is filled and ready for the user to review and submit.', toolHint: 'finish' },
    ],
```

- [ ] **Step 4: Update the executor prompt**

In `src/agent/prompts/index.ts`, replace the single rule on line 87 (`- To FILL a form (e.g. a job application): … Submit when the required fields are filled.`) with these three lines:
```ts
- To FILL a job application: for each TEXT field, tab.type the matching value from USER PROFILE (below). Use ONLY profile values for personal data — never invent a name, email, etc.
- To attach a résumé: call tab.upload_file (it uses the user's stored résumé). The file input is usually HIDDEN, so it has no element index — never tab.click it or hunt for a file input by index.
- Do NOT submit a job application. After every field is filled and the résumé is attached, call finish and report that the form is filled and ready for the user to review and submit.
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `~/.nvm/versions/node/v24.16.0/bin/node node_modules/vitest/vitest.mjs run tests/unit/workflow_memory.test.ts tests/unit/prompts_executor.test.ts`
Expected: PASS (existing workflow tests + the new recipe test + the prompt test).

- [ ] **Step 6: Commit**

```bash
git add src/agent/workflow_memory.ts src/agent/prompts/index.ts tests/unit/workflow_memory.test.ts tests/unit/prompts_executor.test.ts
git commit -m "feat: job recipe + executor prompt attach résumé, never submit"
```

---

## Task 5: Capture résumé bytes in the side panel

**Files:**
- Create: `src/sidepanel/file_bytes.ts`
- Modify: `src/sidepanel/components/SettingsPanel.tsx` (Props, imports, file `onChange`, copy line 101)
- Modify: `src/sidepanel/App.tsx` (pass `onStoreResume`; handle `resumeStored`)
- Modify: `src/background/index.ts` (import `saveResumeFile`; add `handleResumeStore` + case)
- Test: `tests/unit/file_bytes.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/unit/file_bytes.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { fileToBase64 } from '@/sidepanel/file_bytes';

describe('fileToBase64', () => {
  it('encodes the file bytes as base64', async () => {
    const f = new File([new Uint8Array([65, 66, 67])], 'a.bin', { type: 'application/octet-stream' });
    expect(await fileToBase64(f)).toBe('QUJD'); // "ABC"
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `~/.nvm/versions/node/v24.16.0/bin/node node_modules/vitest/vitest.mjs run tests/unit/file_bytes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `file_bytes.ts`**

`src/sidepanel/file_bytes.ts`:
```ts
// File → base64 (no data: prefix). Kept separate from resume.ts so importing it
// in tests does not pull in pdfjs/mammoth and the `?url` worker import.
export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  const chunk = 0x8000; // chunk to avoid call-stack overflow on large files
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `~/.nvm/versions/node/v24.16.0/bin/node node_modules/vitest/vitest.mjs run tests/unit/file_bytes.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire bytes capture into SettingsPanel**

In `src/sidepanel/components/SettingsPanel.tsx`:

(a) Update the import (line 4):
```ts
import { extractResumeText } from '../resume';
import { fileToBase64 } from '../file_bytes';
```

(b) Add to the `Props` interface (after `onExtractProfile`):
```ts
  onStoreResume: (payload: { name: string; mime: string; base64: string }) => void;
```

(c) Add `onStoreResume` to the destructured props in the function signature.

(d) Replace the copy on line 101 (`Resume file upload into a page isn't supported yet.`) with:
```tsx
        Upload a résumé (.pdf / .docx / .txt) and the model fills this in — or edit the JSON directly. The file is also stored so the agent can attach it to an application form.
```

(e) Replace the file input's `onChange` body (lines 108-124) with:
```tsx
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = ''; // allow re-selecting the same file
            if (!file) return;
            setResumeMsg('Reading file…');
            try {
              const base64 = await fileToBase64(file);
              onStoreResume({ name: file.name, mime: file.type || 'application/octet-stream', base64 });
              const text = await extractResumeText(file);
              if (!text.trim()) {
                setResumeMsg('Stored the file. No text found to auto-fill the profile (a scanned PDF needs OCR).');
                return;
              }
              setResumeMsg('Extracting profile with the model…');
              onExtractProfile(text);
            } catch (err) {
              setResumeMsg(`Error: ${(err as Error).message}`);
            }
          }}
```

- [ ] **Step 6: Wire App.tsx → SW**

In `src/sidepanel/App.tsx`:

(a) In the `port.onMessage` switch (after the `profileExtracted` case, ~line 84), add:
```ts
        case 'resumeStored':
          if (msg.ok) {
            setNotice({ msg: `Résumé "${msg.name}" stored — the agent can attach it to applications.`, kind: 'warn' });
          } else {
            setNotice({ msg: msg.error ?? 'Could not store the résumé file.', kind: 'error' });
          }
          break;
```

(b) In the `SettingsPanel` props (after `onExtractProfile`, ~line 200-204), add:
```tsx
          onStoreResume={(payload) => send({ type: 'resume.store', ...payload })}
```

- [ ] **Step 7: Handle `resume.store` in the SW**

In `src/background/index.ts`:

(a) Add `saveResumeFile` to the `state_store` import (lines 5-12):
```ts
  saveSettings,
  saveResumeFile,
  setDomainTier,
```

(b) Add the handler after `handleProfileExtract` (~line 271):
```ts
async function handleResumeStore(name: string, mime: string, base64: string) {
  try {
    await saveResumeFile({ name, mime, base64 });
    broadcast({ type: 'resumeStored', ok: true, name });
  } catch (err) {
    broadcast({ type: 'resumeStored', ok: false, error: `Could not store résumé: ${(err as Error).message}` });
  }
}
```

(c) Add the case in the command switch (after the `profile.extract` case, ~line 333):
```ts
          case 'resume.store':
            void handleResumeStore(cmd.name, cmd.mime, cmd.base64);
            break;
```

- [ ] **Step 8: Typecheck (no unit test for the React/SW wiring)**

Run: `~/.nvm/versions/node/v24.16.0/bin/node node_modules/typescript/bin/tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/sidepanel/file_bytes.ts src/sidepanel/components/SettingsPanel.tsx src/sidepanel/App.tsx src/background/index.ts tests/unit/file_bytes.test.ts
git commit -m "feat: capture résumé bytes on upload and store them in the SW"
```

---

## Task 6: "Apply to a job" entry point

**Files:**
- Create: `src/sidepanel/apply.ts`
- Modify: `src/sidepanel/App.tsx` (add the entry-point section + state)
- Test: `tests/unit/apply.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/unit/apply.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildApplyGoal } from '@/sidepanel/apply';
import { SEED_WORKFLOWS, matchWorkflow } from '@/agent/workflow_memory';

describe('buildApplyGoal', () => {
  it('includes the trimmed URL and the no-submit instruction', () => {
    const g = buildApplyGoal('  https://jobs.lever.co/acme/1  ');
    expect(g).toContain('https://jobs.lever.co/acme/1');
    expect(g).not.toContain('  https');
    expect(g).toMatch(/do not submit/i);
  });

  it('produces a goal that routes to the job-application recipe', () => {
    const wf = matchWorkflow(buildApplyGoal('https://jobs.lever.co/acme/1'), SEED_WORKFLOWS);
    expect(wf?.id).toBe('seed-job-application');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `~/.nvm/versions/node/v24.16.0/bin/node node_modules/vitest/vitest.mjs run tests/unit/apply.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `apply.ts`**

`src/sidepanel/apply.ts`:
```ts
// Turn a job-posting URL into the goal string the agent runs. The wording is
// chosen so the existing keyword matcher routes it to seed-job-application, and
// so the executor fills + attaches + stops (never submits).
export function buildApplyGoal(url: string): string {
  return `Apply to the job application at ${url.trim()}: read the application form, fill every field from my profile, and attach my résumé with the upload tool. Do NOT submit — stop when the form is filled so I can review and submit it myself.`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `~/.nvm/versions/node/v24.16.0/bin/node node_modules/vitest/vitest.mjs run tests/unit/apply.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the entry-point UI**

In `src/sidepanel/App.tsx`:

(a) Add the import near the top:
```ts
import { buildApplyGoal } from './apply';
```

(b) Add state next to `const [goal, setGoal] = useState('');`:
```ts
  const [applyUrl, setApplyUrl] = useState('');
```

(c) Add a handler next to `handleStart`:
```ts
  const handleApply = () => {
    const u = applyUrl.trim();
    if (!u) return;
    const g = buildApplyGoal(u);
    setGoal(g);
    setEvents([]);
    setNotice(null);
    send({ type: 'preflight' });
    send({ type: 'agent.start', goal: g });
  };
```

(d) In the `tab === 'agent'` block, immediately **before** the existing `<div className="goal-row">`, add:
```tsx
          <div className="apply-row" style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <input
              className="goal-input"
              placeholder="Apply to a job: paste a Greenhouse/Lever job URL"
              value={applyUrl}
              onChange={(e) => setApplyUrl(e.target.value)}
              disabled={running}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !running) handleApply();
              }}
            />
            <button className="btn" onClick={handleApply} disabled={running || !applyUrl.trim()}>
              Apply
            </button>
          </div>
```

- [ ] **Step 6: Typecheck**

Run: `~/.nvm/versions/node/v24.16.0/bin/node node_modules/typescript/bin/tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/sidepanel/apply.ts src/sidepanel/App.tsx tests/unit/apply.test.ts
git commit -m "feat: Apply-to-a-job entry point (URL → job-application goal)"
```

---

## Task 7: Full verification + live proof

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole project**

Run: `~/.nvm/versions/node/v24.16.0/bin/node node_modules/typescript/bin/tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Run the full unit suite**

Run: `~/.nvm/versions/node/v24.16.0/bin/node node_modules/vitest/vitest.mjs run`
Expected: all files pass (the 181 prior tests + the new `resume_store`, `upload`, `upload_dispatch`, `file_bytes`, `apply`, `prompts_executor` tests + the new `workflow_memory` case).

- [ ] **Step 3: Production build**

Run: `~/.nvm/versions/node/v24.16.0/bin/node node_modules/vite/bin/vite.js build`
Expected: build succeeds, `dist/` emitted.

- [ ] **Step 4: Live proof (user runs — needs Ollama + Chrome)**

Manual acceptance checklist:
1. Reload the unpacked extension from `extension/dist`.
2. Settings → Profile: upload a real résumé (.pdf or .docx). Confirm the "Résumé … stored" notice and that the profile JSON fills.
3. Settings → Domain tiers: add `boards.greenhouse.io` and `jobs.lever.co` as `click-only` (or `full-action`).
4. Agent tab → "Apply to a job": paste a real Greenhouse posting URL (`boards.greenhouse.io/<co>/jobs/<id>`) → Apply.
5. Confirm: text fields fill from the profile; the résumé filename appears in the upload control; the agent **stops** with a "ready for your review" finish and does **not** submit.
6. Repeat with a Lever posting (`jobs.lever.co/<co>/<id>`).

- [ ] **Step 5: Commit any fixes from the live proof, then summarize results.**

---

## Self-review notes

- **Spec coverage:** §4.1→T1+T5, §4.2→T2+T3, §4.3→T4, §4.4→T4, §4.5→T6, §9 unit→T1-T6, §9 live→T7. No gaps.
- **No orchestrator change** is needed: the observe-then-act gate only blocks repeating the last *observation* tool, and `tab.upload_file` does not navigate (so it stays out of `NAVIGATING_TOOLS` — no auto re-extract; the recipe re-reads explicitly).
- **Type consistency:** `saveResumeFile`/`loadResumeFile` (shape `{name,mime,base64,savedAt}`), `buildLocateExpression`/`buildInjectParams`/`INJECT_FN`/`LOCATE_FN`, `fileToBase64`, `buildApplyGoal`, `tabUploadFileTool`, and the `resume.store`/`resumeStored` message names are used identically across tasks.
