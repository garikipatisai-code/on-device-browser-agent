# Tool Execution Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `tab.click`, `tab.type`, and `tab.select` verify that an action actually produced its intended effect before reporting success, instead of reporting success the instant a CDP call doesn't throw.

**Architecture:** All changes are confined to `extension/src/agent/tools/browser/actions.ts` (no new files, no changes outside this file and its test). Each fix adds a small JS snippet dispatched via the existing `Runtime.callFunctionOn`/`DOM.getNodeForLocation` CDP calls, following the file's existing pattern of small helper functions above each tool definition. Tests extend the existing `extension/tests/unit/actions_readback.test.ts` stub in place.

**Tech Stack:** TypeScript, Chrome DevTools Protocol (via `chrome.debugger`), Vitest.

Spec: `docs/superpowers/specs/2026-07-04-tool-execution-reliability-design.md`

---

## Before you start

Read `extension/src/agent/tools/browser/actions.ts` and `extension/tests/unit/actions_readback.test.ts` in full before making any change — every task below assumes you know the current content of both files. Run `npx vitest run tests/unit/actions_readback.test.ts` once before starting to confirm the baseline is green.

---

### Task 1: `tab.click` — verify checkbox/radio/switch toggles, retry via label

**Files:**
- Modify: `extension/src/agent/tools/browser/actions.ts` (add two helpers after `isEditable`, around line 86; modify `tabClickTool.dispatch`, lines 95-123)
- Test: `extension/tests/unit/actions_readback.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `extension/tests/unit/actions_readback.test.ts`. First, extend the `CdpState` interface and `beforeEach` defaults:

```typescript
interface CdpState {
  connected: boolean;
  objectId: string | undefined;
  selectApplied: boolean;
  selectOptions: string[];
  editable: boolean;
  scrollBefore: number;
  scrollAfter: number;
  toggleSequence: (boolean | null)[];
  labelClickWorked: boolean;
}
```

(add `toggleSequence` and `labelClickWorked` to the existing interface — keep all other fields as they are today)

In `beforeEach`, add to the `s = {...}` initializer:

```typescript
    toggleSequence: [],
    labelClickWorked: false,
```

Add a `let toggleReadIndex = 0;` declaration alongside `let s: CdpState;` at the top of the `describe` block, and reset it in `beforeEach`: `toggleReadIndex = 0;`.

In the `sendCommand` mock's `Runtime.callFunctionOn` branch, add these two conditions (place them before the final `return cb({ result: {} });` fallback, after the existing `isConnected` check):

```typescript
          if (fn.includes('aria-checked')) {
            const v = s.toggleSequence[toggleReadIndex] ?? null;
            toggleReadIndex += 1;
            return cb({ result: { value: v } });
          }
          if (fn.includes('labels[i]')) return cb({ result: { value: s.labelClickWorked } });
```

Now add the test cases (new `describe` block inside the file, after the existing tests):

```typescript
describe('tab.click — checkbox/radio verification', () => {
  // Reuses the same beforeEach/afterEach/ctx from the outer describe — this block must be
  // nested inside the existing describe('action tools — read-back verification...') block,
  // not a separate top-level describe, so it shares the chrome.debugger/chrome.tabs.get stubs.

  it('reports success plainly when a checkbox toggles on the first click', async () => {
    s.toggleSequence = [false, true]; // before: unchecked, after: checked
    const res = await tabClickTool.dispatch({ tabId: 5, elementIndex: 3 }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).not.toMatch(/via associated label/);
  });

  it('retries via the associated label when a checkbox does not toggle on direct click', async () => {
    s.toggleSequence = [false, false]; // before: unchecked, after (post-click): still unchecked
    s.labelClickWorked = true;
    const res = await tabClickTool.dispatch({ tabId: 5, elementIndex: 3 }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/via associated label/);
  });

  it('does not attempt toggle verification on a non-toggle element (link/button)', async () => {
    s.toggleSequence = []; // readToggleState returns null (no entries) — not a checkbox/radio/switch
    const res = await tabClickTool.dispatch({ tabId: 5, elementIndex: 3 }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).not.toMatch(/via associated label/);
  });
});
```

Move these three `it(...)` blocks inside the existing `describe('action tools — read-back verification (no phantom success)', () => { ... })` block (right after the existing `tab.select`/`tab.type`/`tab.scroll` tests, before the closing `});` of that describe) rather than as a separate nested describe, so they share the same `beforeEach`/`afterEach`/`ctx()`. Drop the comment about nesting and just place the three `it()` calls directly in the existing describe body.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extension && npx vitest run tests/unit/actions_readback.test.ts`
Expected: FAIL — `toggleSequence`/`labelClickWorked` don't exist on `CdpState` yet (TypeScript error) and the new assertions don't match current behavior (`tabClickTool` doesn't read toggle state at all yet, so `res.content` never contains "via associated label").

- [ ] **Step 3: Implement**

In `extension/src/agent/tools/browser/actions.ts`, add these two functions right after `isEditable` (after line 86, before `export const tabClickTool`):

```typescript
// A click that should have toggled a checkbox/radio/switch but silently didn't often means the
// resolved node isn't the thing a real user would click (a visually-hidden real <input> with a
// styled sibling handling the actual toggle is a common pattern). Read the toggle state before
// and after so that case is caught instead of reported as a phantom success. Returns null for
// anything that isn't a checkbox/radio/switch — no verification applies to those.
async function readToggleState(
  send: <T>(m: string, p?: Record<string, unknown>) => Promise<T>,
  objectId: string,
): Promise<boolean | null> {
  try {
    const { result } = await send<{ result?: { value?: unknown } }>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration:
        "function(){ try { var t=(this.type||'').toLowerCase(); if(t==='checkbox'||t==='radio') return this.checked; var r=(this.getAttribute&&this.getAttribute('role'))||''; if(r==='switch'||r==='checkbox'||r==='menuitemcheckbox') return this.getAttribute('aria-checked')==='true'; return null; } catch(e){ return null; } }",
      returnByValue: true,
    });
    return (result?.value as boolean | null) ?? null;
  } catch {
    return null;
  }
}

// Fallback when a direct click on the resolved node didn't toggle it: click whatever <label>
// is actually wired to it instead.
async function clickAssociatedLabel(
  send: <T>(m: string, p?: Record<string, unknown>) => Promise<T>,
  objectId: string,
): Promise<boolean> {
  try {
    const { result } = await send<{ result?: { value?: boolean } }>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration:
        "function(){ try { var l=null; if(this.id){ var labels=document.querySelectorAll('label'); for(var i=0;i<labels.length;i++){ if(labels[i].getAttribute('for')===this.id){ l=labels[i]; break; } } } if(!l){ l=this.closest('label'); } if(l){ l.click(); return true; } return false; } catch(e){ return false; } }",
      returnByValue: true,
    });
    return result?.value === true;
  } catch {
    return false;
  }
}
```

Replace `tabClickTool.dispatch` (the whole method body, lines 95-123 in the current file) with:

```typescript
  async dispatch({ tabId, elementIndex }, ctx) {
    const url = await tabUrl(tabId);
    assertCanAct(url, 'click-only', ctx.settings.domainTiers, ctx.settings.bypassDomainTiers);
    const backendNodeId = await resolveBackendId(tabId, elementIndex);
    let retriedViaLabel = false;
    const stale = await withCdp(tabId, async (send) => {
      await send('DOM.enable');
      await scrollIntoView(send, backendNodeId);
      const objectId = await resolveObjectId(send, backendNodeId);
      if (objectId) {
        if (!(await isElementConnected(send, objectId))) return true; // detached → stale
        const before = await readToggleState(send, objectId);
        // Native element.click() reliably follows links, fires handlers, and
        // submits forms even on a background tab. Synthetic mouse coordinates
        // often did NOT navigate (a product-link click left the URL unchanged).
        await send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: 'function() { this.click(); }',
          returnByValue: true,
        });
        if (before !== null) {
          const after = await readToggleState(send, objectId);
          if (after === before && (await clickAssociatedLabel(send, objectId))) {
            retriedViaLabel = true;
          }
        }
      } else {
        const { x, y } = await elementCenter(send, backendNodeId);
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      }
      return false;
    });
    if (stale) return { ok: false, content: staleMsg(elementIndex) };
    clearExtractionCache(tabId);
    const via = retriedViaLabel ? ' (via associated label — direct click did not toggle it)' : '';
    return { ok: true, content: `Clicked element [${elementIndex}] on tab ${tabId}${via}` };
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && npx vitest run tests/unit/actions_readback.test.ts`
Expected: PASS — all tests including the 3 new ones.

- [ ] **Step 5: Typecheck**

Run: `cd extension && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add extension/src/agent/tools/browser/actions.ts extension/tests/unit/actions_readback.test.ts
git commit -m "fix(tools): verify checkbox/radio/switch toggled after tab.click, retry via label"
```

---

### Task 2: `tab.click` — occlusion check on the coordinate fallback

**Files:**
- Modify: `extension/src/agent/tools/browser/actions.ts` (add one helper; modify the `else` branch of `tabClickTool.dispatch` from Task 1)
- Test: `extension/tests/unit/actions_readback.test.ts`

- [ ] **Step 1: Write the failing test**

Add `pointBackendNodeId: number | undefined;` to the `CdpState` interface, and `pointBackendNodeId: 42,` to the `beforeEach` initializer (42 matches the mocked `resolveBackendId` return value at the top of the file — this represents "the point resolves to the same node we're trying to click," i.e. not occluded, as the default).

In the `sendCommand` mock, add a new top-level branch (alongside the existing `DOM.resolveNode` check, before the `Runtime.callFunctionOn` block):

```typescript
        if (method === 'DOM.getNodeForLocation') return cb({ backendNodeId: s.pointBackendNodeId });
```

Add two test cases inside the existing `describe('action tools — read-back verification (no phantom success)', ...)` block:

```typescript
  it('tab.click dispatches a coordinate click when the point is not occluded', async () => {
    s.objectId = undefined; // forces the coordinate-fallback branch
    s.pointBackendNodeId = 42; // matches resolveBackendId's mocked return — not occluded
    const res = await tabClickTool.dispatch({ tabId: 5, elementIndex: 3 }, ctx());
    expect(res.ok).toBe(true);
  });

  it('tab.click refuses a coordinate click when the point is occluded by another element', async () => {
    s.objectId = undefined; // forces the coordinate-fallback branch
    s.pointBackendNodeId = 999; // a different node is actually at that point
    const res = await tabClickTool.dispatch({ tabId: 5, elementIndex: 3 }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/covered by another element/);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extension && npx vitest run tests/unit/actions_readback.test.ts`
Expected: FAIL — `pointBackendNodeId` doesn't exist on `CdpState` (TypeScript error), and the occlusion case reports `ok: true` today since there's no occlusion check at all yet.

- [ ] **Step 3: Implement**

Add this helper to `actions.ts`, right after `clickAssociatedLabel` (from Task 1):

```typescript
// Checked only on the coordinate-fallback path (no resolvable JS object reference exists for
// the target, so an in-page elementFromPoint-vs-object comparison isn't possible). Uses CDP's
// own "what's actually at this point" primitive instead. Fails open — an inconclusive check
// must never block a click that would otherwise have worked.
async function isPointOccluded(
  send: <T>(m: string, p?: Record<string, unknown>) => Promise<T>,
  x: number,
  y: number,
  targetBackendNodeId: number,
): Promise<boolean> {
  try {
    const { backendNodeId } = await send<{ backendNodeId?: number }>('DOM.getNodeForLocation', {
      x: Math.round(x),
      y: Math.round(y),
    });
    if (typeof backendNodeId !== 'number') return false;
    return backendNodeId !== targetBackendNodeId;
  } catch {
    return false;
  }
}
```

In `tabClickTool.dispatch` (from Task 1), add an `occluded` flag and check it in the `else` branch. The full method becomes:

```typescript
  async dispatch({ tabId, elementIndex }, ctx) {
    const url = await tabUrl(tabId);
    assertCanAct(url, 'click-only', ctx.settings.domainTiers, ctx.settings.bypassDomainTiers);
    const backendNodeId = await resolveBackendId(tabId, elementIndex);
    let retriedViaLabel = false;
    let occluded = false;
    const stale = await withCdp(tabId, async (send) => {
      await send('DOM.enable');
      await scrollIntoView(send, backendNodeId);
      const objectId = await resolveObjectId(send, backendNodeId);
      if (objectId) {
        if (!(await isElementConnected(send, objectId))) return true; // detached → stale
        const before = await readToggleState(send, objectId);
        // Native element.click() reliably follows links, fires handlers, and
        // submits forms even on a background tab. Synthetic mouse coordinates
        // often did NOT navigate (a product-link click left the URL unchanged).
        await send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: 'function() { this.click(); }',
          returnByValue: true,
        });
        if (before !== null) {
          const after = await readToggleState(send, objectId);
          if (after === before && (await clickAssociatedLabel(send, objectId))) {
            retriedViaLabel = true;
          }
        }
      } else {
        const { x, y } = await elementCenter(send, backendNodeId);
        if (await isPointOccluded(send, x, y, backendNodeId)) {
          occluded = true;
          return false;
        }
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      }
      return false;
    });
    if (stale) return { ok: false, content: staleMsg(elementIndex) };
    if (occluded) {
      return {
        ok: false,
        content: `Element [${elementIndex}] is covered by another element at that position — call aria.extract to see what's on top, or scroll it into view.`,
      };
    }
    clearExtractionCache(tabId);
    const via = retriedViaLabel ? ' (via associated label — direct click did not toggle it)' : '';
    return { ok: true, content: `Clicked element [${elementIndex}] on tab ${tabId}${via}` };
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && npx vitest run tests/unit/actions_readback.test.ts`
Expected: PASS — all tests including the 2 new ones.

- [ ] **Step 5: Typecheck**

Run: `cd extension && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add extension/src/agent/tools/browser/actions.ts extension/tests/unit/actions_readback.test.ts
git commit -m "fix(tools): refuse a coordinate click when the target point is occluded"
```

---

### Task 3: `tab.type` — native-setter clear

**Files:**
- Modify: `extension/src/agent/tools/browser/actions.ts` (add one helper; modify the `clear` branch inside `tabTypeTool.dispatch`, current line 152-158)
- Test: `extension/tests/unit/actions_readback.test.ts`

- [ ] **Step 1: Write the failing test**

The existing stub already simulates a real CDP round-trip without a real DOM, so there's no direct way to observe "did the clear use the native setter" from the outside other than pinning the exact `functionDeclaration` sent for the clear step, so a regression back to a plain `this.value = ""` assignment is caught. Wrap (not replace) the shared `beforeEach`-installed `sendCommand` so every other call still behaves exactly as the rest of the suite expects — this test only taps in as an observer:

```typescript
  it('tab.type clears via the native value setter, not a plain assignment', async () => {
    const seen: string[] = [];
    const origSend = chrome.debugger.sendCommand;
    chrome.debugger.sendCommand = ((t: unknown, method: string, p: { functionDeclaration?: string } | undefined, cb: (r?: unknown) => void) => {
      if (method === 'Runtime.callFunctionOn' && p?.functionDeclaration) seen.push(p.functionDeclaration);
      return (origSend as unknown as (t: unknown, m: string, p: unknown, cb: (r?: unknown) => void) => void)(t, method, p, cb);
    }) as unknown as typeof chrome.debugger.sendCommand;
    await tabTypeTool.dispatch({ tabId: 5, elementIndex: 3, text: 'hello', clear: true }, ctx());
    const clearCall = seen.find((fn) => fn.includes('getOwnPropertyDescriptor'));
    expect(clearCall).toBeDefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run tests/unit/actions_readback.test.ts`
Expected: FAIL — no `functionDeclaration` sent by `tab.type`'s clear step contains `getOwnPropertyDescriptor` yet (current code sends `this.value = ""`).

- [ ] **Step 3: Implement**

Add this constant to `actions.ts`, right after `isPointOccluded` (from Task 2):

```typescript
// Plain `this.value = ""` is a raw property assignment; a framework-controlled field (React
// and similar) can silently revert it on the next render since it bypasses the framework's
// tracked-value setter. Going through the property descriptor's own setter — the same one the
// framework itself would call — makes the clear (and later, direct value assignment) actually
// stick.
const SET_NATIVE_VALUE_FN = `function(v){
  try {
    var proto = this.tagName==='TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) { desc.set.call(this, v); } else { this.value = v; }
    this.dispatchEvent(new Event('input', {bubbles:true}));
  } catch(e) { try { this.value = v; } catch(e2) {} }
}`;
```

In `tabTypeTool.dispatch`, replace the `clear` branch (current lines 152-158):

```typescript
      if (clear && objectId) {
        await send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: 'function() { try { this.value = ""; this.dispatchEvent(new Event("input", {bubbles:true})); } catch(e) {} }',
          returnByValue: true,
        });
      }
```

with:

```typescript
      if (clear && objectId) {
        await send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: SET_NATIVE_VALUE_FN,
          arguments: [{ value: '' }],
          returnByValue: true,
        });
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && npx vitest run tests/unit/actions_readback.test.ts`
Expected: PASS — all tests including the new one.

- [ ] **Step 5: Typecheck**

Run: `cd extension && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add extension/src/agent/tools/browser/actions.ts extension/tests/unit/actions_readback.test.ts
git commit -m "fix(tools): clear tab.type fields via the native value setter, not a raw assignment"
```

---

### Task 4: `tab.type` — type-aware branch for date/time/color/range inputs

**Files:**
- Modify: `extension/src/agent/tools/browser/actions.ts` (replace `isEditable` with `checkEditableAndType`; add `SPECIAL_VALUE_TYPES`; modify `tabTypeTool.dispatch`)
- Test: `extension/tests/unit/actions_readback.test.ts`

- [ ] **Step 1: Write the failing tests**

Add `inputType: string;` to `CdpState` and `inputType: '',` to the `beforeEach` initializer.

Update the existing `isContentEditable` stub branch (already touched by Task 3's test, but that test built its own local override — this step changes the *shared* `beforeEach` stub used by every other test in the file) from:

```typescript
          if (fn.includes('isContentEditable')) return cb({ result: { value: s.editable } });
```

to:

```typescript
          if (fn.includes('isContentEditable')) return cb({ result: { value: { editable: s.editable, type: s.inputType } } });
```

Add two test cases inside the existing describe block:

```typescript
  it('tab.type assigns a date value via the native setter instead of Input.insertText', async () => {
    s.inputType = 'date';
    const seenMethods: string[] = [];
    const origSend = chrome.debugger.sendCommand;
    chrome.debugger.sendCommand = ((t: unknown, method: string, p: unknown, cb: (r?: unknown) => void) => {
      seenMethods.push(method);
      return (origSend as unknown as (t: unknown, m: string, p: unknown, cb: (r?: unknown) => void) => void)(t, method, p, cb);
    }) as unknown as typeof chrome.debugger.sendCommand;
    const res = await tabTypeTool.dispatch({ tabId: 5, elementIndex: 3, text: '2026-07-04' }, ctx());
    expect(res.ok).toBe(true);
    expect(seenMethods).not.toContain('Input.insertText');
  });

  it('tab.type still uses Input.insertText for a plain text field', async () => {
    s.inputType = '';
    const seenMethods: string[] = [];
    const origSend = chrome.debugger.sendCommand;
    chrome.debugger.sendCommand = ((t: unknown, method: string, p: unknown, cb: (r?: unknown) => void) => {
      seenMethods.push(method);
      return (origSend as unknown as (t: unknown, m: string, p: unknown, cb: (r?: unknown) => void) => void)(t, method, p, cb);
    }) as unknown as typeof chrome.debugger.sendCommand;
    const res = await tabTypeTool.dispatch({ tabId: 5, elementIndex: 3, text: 'hello' }, ctx());
    expect(res.ok).toBe(true);
    expect(seenMethods).toContain('Input.insertText');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extension && npx vitest run tests/unit/actions_readback.test.ts`
Expected: FAIL — `inputType` doesn't exist on `CdpState` yet, and there's no type-aware branching in `tab.type` yet (a `date` input would still go through `Input.insertText` today).

- [ ] **Step 3: Implement**

In `actions.ts`, delete the existing `isEditable` function (current lines 71-86) and replace it with:

```typescript
// Input.insertText goes to whatever is focused; if the resolved element isn't a text field the
// keystrokes vanish but the action still looks like success. Verify the target is editable so a
// mis-indexed button/link/heading is reported, not silently typed into. Kept permissive (any
// input/textarea/contenteditable + textbox/searchbox/combobox/spinbutton roles) to avoid
// rejecting a legitimate field. Also reports the element's HTML `type` (date/color/range/etc.)
// so the caller can branch to a different value-assignment strategy for input shapes that
// Input.insertText does not handle correctly.
async function checkEditableAndType(
  send: <T>(m: string, p?: Record<string, unknown>) => Promise<T>,
  objectId: string,
): Promise<{ editable: boolean; type: string }> {
  try {
    const { result } = await send<{ result?: { value?: { editable?: boolean; type?: string } } }>(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration:
          "function(){ try { var r=(this.getAttribute&&this.getAttribute('role'))||''; var editable=!!(this.isContentEditable || this.tagName==='INPUT' || this.tagName==='TEXTAREA' || r==='textbox' || r==='searchbox' || r==='combobox' || r==='spinbutton'); return {editable:editable, type:(this.type||'').toLowerCase()}; } catch(e){ return {editable:true, type:''}; } }",
        returnByValue: true,
      },
    );
    return { editable: result?.value?.editable ?? true, type: result?.value?.type ?? '' };
  } catch {
    return { editable: true, type: '' }; // can't tell → don't block a possibly-valid field
  }
}
```

Add this constant near `SET_NATIVE_VALUE_FN` (from Task 3):

```typescript
// Input.insertText does not reliably work on these input shapes — they need direct value
// assignment via the native setter instead (see SET_NATIVE_VALUE_FN above).
const SPECIAL_VALUE_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range']);
```

Replace `tabTypeTool.dispatch` (the whole method body) with:

```typescript
  async dispatch({ tabId, elementIndex, text, clear, submit }, ctx) {
    const url = await tabUrl(tabId);
    assertCanAct(url, 'click-only', ctx.settings.domainTiers, ctx.settings.bypassDomainTiers);
    const backendNodeId = await resolveBackendId(tabId, elementIndex);
    let notEditable = false;
    const stale = await withCdp(tabId, async (send) => {
      await send('DOM.enable');
      await scrollIntoView(send, backendNodeId);
      await focusNode(send, backendNodeId);
      const objectId = await resolveObjectId(send, backendNodeId);
      if (objectId && !(await isElementConnected(send, objectId))) return true; // detached → stale
      if (!objectId) {
        await send('Input.insertText', { text });
        return false;
      }
      const { editable, type } = await checkEditableAndType(send, objectId);
      if (!editable) {
        notEditable = true;
        return false;
      }
      if (SPECIAL_VALUE_TYPES.has(type)) {
        // Direct assignment replaces whatever was there — there's no meaningful "clear then
        // type" for a date/color/range control, so `clear` is not consulted on this branch.
        await send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: SET_NATIVE_VALUE_FN,
          arguments: [{ value: text }],
          returnByValue: true,
        });
        if (submit) {
          await send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration:
              'function(){ var f=this.form||this.closest("form"); if(f){ if(f.requestSubmit) f.requestSubmit(); else f.submit(); return; } this.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",keyCode:13,which:13,bubbles:true})); this.dispatchEvent(new KeyboardEvent("keyup",{key:"Enter",keyCode:13,which:13,bubbles:true})); }',
            returnByValue: true,
          });
        }
        return false;
      }
      if (clear) {
        await send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: SET_NATIVE_VALUE_FN,
          arguments: [{ value: '' }],
          returnByValue: true,
        });
      }
      await send('Input.insertText', { text });
      if (submit) {
        // Submit via JS — a synthetic Enter/mouse event hangs on a background tab.
        await send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration:
            'function(){ var f=this.form||this.closest("form"); if(f){ if(f.requestSubmit) f.requestSubmit(); else f.submit(); return; } this.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",keyCode:13,which:13,bubbles:true})); this.dispatchEvent(new KeyboardEvent("keyup",{key:"Enter",keyCode:13,which:13,bubbles:true})); }',
          returnByValue: true,
        });
      }
      return false;
    });
    if (stale) return { ok: false, content: staleMsg(elementIndex) };
    if (notEditable) {
      return {
        ok: false,
        content: `Element [${elementIndex}] is not a text field — keystrokes would go nowhere. Use tab.click for buttons/links, or call aria.extract to find the actual input.`,
      };
    }
    clearExtractionCache(tabId);
    return { ok: true, content: `Typed ${text.length} chars into element [${elementIndex}]${submit ? ' and submitted' : ''}` };
  },
```

Note: the two `submit` blocks (special-type branch and plain-text branch) are intentionally duplicated rather than factored into a shared call in this task — Task 5 touches the plain-text branch again immediately after, and factoring now would just mean re-inlining or re-extracting one step later. Leave the small duplication for Task 5 to clean up.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && npx vitest run tests/unit/actions_readback.test.ts`
Expected: PASS — all tests including the 2 new ones. The Task 3 test (which used its own local `sendCommand` override with the `{editable, type}` shape already) should still pass unchanged.

- [ ] **Step 5: Typecheck**

Run: `cd extension && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add extension/src/agent/tools/browser/actions.ts extension/tests/unit/actions_readback.test.ts
git commit -m "fix(tools): assign date/time/color/range values natively instead of via Input.insertText"
```

---

### Task 5: `tab.type` — read-back-and-verify after typing

**Files:**
- Modify: `extension/src/agent/tools/browser/actions.ts` (add helper; modify the plain-text branch of `tabTypeTool.dispatch`; extract `submitViaJs`)
- Test: `extension/tests/unit/actions_readback.test.ts`

- [ ] **Step 1: Write the failing test**

Add `typedValueReadback: string;` to `CdpState` and `typedValueReadback: '',` to the `beforeEach` initializer.

In the `sendCommand` mock's `Runtime.callFunctionOn` branch, add (the substring `'this.value||'` is unique to the new read-back function — it doesn't appear in `SET_NATIVE_VALUE_FN`, which only *writes* `.value`, never reads it back with that exact expression):

```typescript
          if (fn.includes('this.value||')) return cb({ result: { value: s.typedValueReadback } });
```

Add test cases:

```typescript
  it('tab.type retries the clear when leftover content is detected after typing', async () => {
    s.typedValueReadback = 'oldhello'; // leftover "old" + newly typed "hello"
    const res = await tabTypeTool.dispatch({ tabId: 5, elementIndex: 3, text: 'hello', clear: true }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/retried/i);
  });

  it('tab.type does not report a retry when the typed value matches exactly', async () => {
    s.typedValueReadback = 'hello';
    const res = await tabTypeTool.dispatch({ tabId: 5, elementIndex: 3, text: 'hello', clear: true }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).not.toMatch(/retried/i);
  });

  it('tab.type does not report a retry when a reformatted value merely differs (not concatenation)', async () => {
    s.typedValueReadback = '555-123-4567'; // shorter than or same length as typed digits-only text — not concatenation
    const res = await tabTypeTool.dispatch({ tabId: 5, elementIndex: 3, text: '5551234567', clear: true }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).not.toMatch(/retried/i);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extension && npx vitest run tests/unit/actions_readback.test.ts`
Expected: FAIL — `typedValueReadback` doesn't exist on `CdpState` yet, and there's no read-back check in `tab.type` yet, so "retried" never appears in any success message.

- [ ] **Step 3: Implement**

Add this helper to `actions.ts`, right after `checkEditableAndType` (from Task 4):

```typescript
async function readValue(
  send: <T>(m: string, p?: Record<string, unknown>) => Promise<T>,
  objectId: string,
): Promise<string> {
  try {
    const { result } = await send<{ result?: { value?: string } }>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: "function(){ try { return String(this.value||''); } catch(e){ return ''; } }",
      returnByValue: true,
    });
    return result?.value ?? '';
  } catch {
    return '';
  }
}
```

Extract the repeated submit snippet (currently inlined twice as of Task 4) into a shared helper, placed right after `readValue`:

```typescript
// Submit via JS — a synthetic Enter/mouse event hangs on a background tab.
async function submitViaJs(send: <T>(m: string, p?: Record<string, unknown>) => Promise<T>, objectId: string): Promise<void> {
  await send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration:
      'function(){ var f=this.form||this.closest("form"); if(f){ if(f.requestSubmit) f.requestSubmit(); else f.submit(); return; } this.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",keyCode:13,which:13,bubbles:true})); this.dispatchEvent(new KeyboardEvent("keyup",{key:"Enter",keyCode:13,which:13,bubbles:true})); }',
    returnByValue: true,
  });
}
```

Replace both inlined submit blocks from Task 4 (`if (submit) { await send('Runtime.callFunctionOn', {... the submit snippet ...}); }`) with `if (submit) await submitViaJs(send, objectId);` in both the special-type branch and the plain-text branch.

Add `let retriedClear = false;` next to the existing `let notEditable = false;` near the top of `dispatch`.

Then replace the plain-text tail of `tabTypeTool.dispatch` — from the second `await send('Input.insertText', { text });` occurrence (the one in the plain-text branch, not the one inside the `!objectId` early return) through the `if (submit) await submitViaJs(send, objectId);` line right after it — with:

```typescript
      await send('Input.insertText', { text });
      const actual = await readValue(send, objectId);
      if (actual !== text && actual.length > text.length && actual.includes(text)) {
        // Leftover content wasn't fully cleared before typing — retry once via a hard clear.
        await send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: SET_NATIVE_VALUE_FN,
          arguments: [{ value: '' }],
          returnByValue: true,
        });
        await send('Input.insertText', { text });
        retriedClear = true;
      }
      if (submit) await submitViaJs(send, objectId);
      return false;
```

Finally, update the success return at the bottom of `dispatch` from:

```typescript
    return { ok: true, content: `Typed ${text.length} chars into element [${elementIndex}]${submit ? ' and submitted' : ''}` };
```

to:

```typescript
    const retryNote = retriedClear ? ' (retried after leftover content was detected)' : '';
    return {
      ok: true,
      content: `Typed ${text.length} chars into element [${elementIndex}]${submit ? ' and submitted' : ''}${retryNote}`,
    };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && npx vitest run tests/unit/actions_readback.test.ts`
Expected: PASS — all tests including the 3 new ones.

- [ ] **Step 5: Typecheck**

Run: `cd extension && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add extension/src/agent/tools/browser/actions.ts extension/tests/unit/actions_readback.test.ts
git commit -m "fix(tools): detect and retry a leftover-content concatenation after tab.type"
```

---

### Task 6: `tab.select` — ARIA combobox+listbox support

**Files:**
- Modify: `extension/src/agent/tools/browser/actions.ts` (add two helpers; modify `tabSelectTool.dispatch`)
- Test: `extension/tests/unit/actions_readback.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `CdpState`: `comboboxHasListbox: boolean; comboboxOk: boolean; comboboxOptions: string[];` and to `beforeEach`: `comboboxHasListbox: false, comboboxOk: true, comboboxOptions: ['Large', 'Small'],`. `comboboxHasListbox` defaults to `false` so every pre-existing `tab.select` test (which never sets it) keeps taking the native-`<select>` branch unchanged.

In the `sendCommand` mock's `Runtime.callFunctionOn` branch, add (place before the existing `fn.includes('options')` check, since that check's substring is generic enough it could otherwise shadow these):

```typescript
          if (fn.includes('hasListbox')) return cb({ result: { value: { tag: 'DIV', role: 'combobox', hasListbox: s.comboboxHasListbox } } });
          if (fn.includes('matchIndex')) return cb({ result: { value: { ok: s.comboboxOk, options: s.comboboxOptions } } });
```

Add test cases:

```typescript
  it('tab.select expands and picks an option on an ARIA combobox', async () => {
    s.comboboxHasListbox = true;
    s.comboboxOk = true;
    s.comboboxOptions = ['Large', 'Small'];
    const res = await tabSelectTool.dispatch({ tabId: 5, elementIndex: 3, value: 'Large' }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/selected/i);
  });

  it('tab.select reports the available options when no combobox option matches', async () => {
    s.comboboxHasListbox = true;
    s.comboboxOk = false;
    s.comboboxOptions = ['Large', 'Small'];
    const res = await tabSelectTool.dispatch({ tabId: 5, elementIndex: 3, value: 'Medium' }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/Large/);
    expect(res.content).toMatch(/Small/);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extension && npx vitest run tests/unit/actions_readback.test.ts`
Expected: FAIL — `comboboxOk`/`comboboxOptions` don't exist on `CdpState` yet, and `tab.select` has no combobox branch yet (both new tests would currently fail with "not a valid option" / "target is not a <select>" content instead).

- [ ] **Step 3: Implement**

Add these two items to `actions.ts`, right after `submitViaJs` (from Task 5):

```typescript
// Distinguishes a real <select> from an ARIA-combobox-shaped custom dropdown (React-Select,
// MUI, Radix, and similar component libraries render this pattern) before deciding which
// selection strategy to use.
async function readTagAndRole(
  send: <T>(m: string, p?: Record<string, unknown>) => Promise<T>,
  objectId: string,
): Promise<{ tag: string; hasListbox: boolean }> {
  try {
    const { result } = await send<{ result?: { value?: { tag?: string; hasListbox?: boolean } } }>(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration:
          "function(){ try { var r=(this.getAttribute&&this.getAttribute('role'))||''; var lbId=this.getAttribute('aria-controls')||this.getAttribute('aria-owns'); return {tag:this.tagName, role:r, hasListbox: r==='combobox' && !!lbId}; } catch(e){ return {tag:'', role:'', hasListbox:false}; } }",
        returnByValue: true,
      },
    );
    return { tag: result?.value?.tag ?? '', hasListbox: result?.value?.hasListbox === true };
  } catch {
    return { tag: '', hasListbox: false };
  }
}

// Expands an ARIA combobox, matches `value` against its referenced listbox's option text
// (case-insensitive, trimmed — ARIA listbox options have no native `value` attribute the way
// <option> does), clicks the match, then collapses the popup again. Runs entirely in-page as
// one Promise-returning function so the render delay after expanding doesn't need a second
// round-trip.
const SELECT_ARIA_COMBOBOX_FN = `function(value){
  var el = this;
  return new Promise(function(resolve){
    try {
      var listboxId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
      el.focus();
      el.click();
      setTimeout(function(){
        var listbox = document.getElementById(listboxId);
        var opts = listbox ? Array.prototype.slice.call(listbox.querySelectorAll('[role="option"]')) : [];
        var texts = opts.map(function(o){ return (o.textContent||'').trim(); });
        var want = String(value).trim().toLowerCase();
        var matchIndex = -1;
        for (var i=0;i<texts.length;i++){ if (texts[i].toLowerCase()===want){ matchIndex=i; break; } }
        if (matchIndex===-1){
          el.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
          resolve({ok:false, options:texts});
          return;
        }
        opts[matchIndex].click();
        setTimeout(function(){
          if (el.getAttribute('aria-expanded')==='true'){
            el.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
          }
          resolve({ok:true, options:texts});
        }, 150);
      }, 400);
    } catch(e){ resolve({ok:false, options:[]}); }
  });
}`;
```

Replace the body of the `withCdp` callback inside `tabSelectTool.dispatch` — from `const objectId = await resolveObjectId(send, backendNodeId);` through the final `return { stale: false, applied: ..., options: ... } as const;` (current lines 197-211) — with:

```typescript
      const objectId = await resolveObjectId(send, backendNodeId);
      // An unresolvable node usually means the page changed under us — give the same
      // actionable refresh guidance the other action tools give, not a bare throw.
      if (!objectId) return { stale: true } as const;
      if (!(await isElementConnected(send, objectId))) return { stale: true } as const;
      const { tag, hasListbox } = await readTagAndRole(send, objectId);
      if (tag !== 'SELECT' && hasListbox) {
        const { result } = await send<{ result?: { value?: { ok?: boolean; options?: string[] } } }>(
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration: SELECT_ARIA_COMBOBOX_FN,
            arguments: [{ value }],
            returnByValue: true,
            awaitPromise: true,
          },
        );
        return { stale: false, applied: result?.value?.ok === true, options: result?.value?.options ?? [] } as const;
      }
      // A <select> ignores assignment of a value that isn't one of its options, so read the
      // value back: if it didn't take, the model passed a label/guess instead of the real value.
      const { result } = await send<{ result?: { value?: { ok?: boolean; options?: string[] } } }>(
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration:
            "function(v){ try { if(this.tagName!=='SELECT') return {ok:false, options:[]}; var opts=Array.from(this.options).map(function(o){return o.value;}); this.value=v; var ok=this.value===v; if(ok) this.dispatchEvent(new Event('change',{bubbles:true})); return {ok:ok, options:opts}; } catch(e){ return {ok:false, options:[]}; } }",
          arguments: [{ value }],
          returnByValue: true,
        },
      );
      return { stale: false, applied: result?.value?.ok === true, options: result?.value?.options ?? [] } as const;
```

The rest of `tabSelectTool.dispatch` (the `outcome.stale`/`outcome.applied` handling below the `withCdp` call) is unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && npx vitest run tests/unit/actions_readback.test.ts`
Expected: PASS — all tests including the 2 new ones. The pre-existing native-`<select>` tests keep passing unchanged, since `comboboxHasListbox` defaults to `false` for them and `tabSelectTool.dispatch` falls through to the exact same native-`<select>` branch as before Task 6.

- [ ] **Step 5: Typecheck**

Run: `cd extension && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add extension/src/agent/tools/browser/actions.ts extension/tests/unit/actions_readback.test.ts
git commit -m "feat(tools): support ARIA combobox+listbox dropdowns in tab.select"
```

---

## Final check

- [ ] Run the full suite: `cd extension && npm test` — expect all tests green, not just `actions_readback.test.ts`.
- [ ] Run `cd extension && npm run build` — expect a clean build (`tsc --noEmit && vite build`).
