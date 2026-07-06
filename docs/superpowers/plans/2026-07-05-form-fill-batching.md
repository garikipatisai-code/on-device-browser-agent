# Form-Fill Batching (`tab.fill_many`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `tab.fill_many` tool that fills several known text fields in one dispatch (one model turn) instead of one `tab.type` call per field, cutting N local-LLM round-trips to 1 for the form-fill pattern.

**Architecture:** Extract `tab.type`'s existing per-field CDP logic into a `fillOneFieldWithSend(send, ...)` helper that takes an already-open CDP connection. `tab.type` keeps its own single-field `withCdp` wrapper around it (behavior unchanged). The new `tab.fill_many` opens exactly one `withCdp` for the whole batch and calls the same helper once per field, sequentially, inside it — never N concurrent `withCdp` calls (which would race `chrome.debugger` attach/detach on the same tab).

**Tech Stack:** TypeScript, Zod, Vitest (existing `CdpState`-driven mock pattern in `tests/unit/actions_readback.test.ts`).

**Spec:** `docs/superpowers/specs/2026-07-05-form-fill-batching-design.md`

---

### Task 1: Extract `fillOneFieldWithSend`, rewire `tab.type` through it (pure refactor)

**Files:**
- Modify: `extension/src/agent/tools/browser/actions.ts:358-440` (the `tabTypeTool` definition)
- Test: `extension/tests/unit/actions_readback.test.ts` (no new tests — this task's correctness gate is that the 10 existing `tab.type` tests keep passing unchanged)

- [ ] **Step 1: Confirm the regression baseline passes before touching anything**

Run: `cd extension && npx vitest run tests/unit/actions_readback.test.ts`
Expected: PASS (all existing tests, including the 10 `tabTypeTool.dispatch` cases) — this is your baseline; if any of these fail before you've changed a line, stop and investigate the environment, not the code.

- [ ] **Step 2: Add the `fillOneFieldWithSend` helper and rewrite `tabTypeTool.dispatch` to use it**

In `extension/src/agent/tools/browser/actions.ts`, insert this new function immediately before `export const tabClickTool` (i.e., right after the `SELECT_ARIA_COMBOBOX_FN` constant, before line 295 in the current file):

```ts
// Shared by tab.type (one field, its own withCdp) and tab.fill_many (N fields, one shared
// withCdp) -- takes an already-open CDP connection so a caller filling several fields can do it
// inside a single attach/detach cycle instead of racing N concurrent ones (chrome.debugger is
// exclusive per tab; withCdp's own finally-detach would otherwise fire while a sibling call was
// still mid-command). This is exactly the per-field body tab.type already had; nothing about
// the read-back-verify/native-setter/date-type logic changed, only where the withCdp lives.
async function fillOneFieldWithSend(
  send: SendCmd,
  backendNodeId: number,
  elementIndex: number,
  text: string,
  opts: { clear?: boolean; submit?: boolean } = {},
): Promise<{ ok: boolean; content: string }> {
  await scrollIntoView(send, backendNodeId);
  await focusNode(send, backendNodeId);
  const objectId = await resolveObjectId(send, backendNodeId);
  if (objectId && !(await isElementConnected(send, objectId))) {
    return { ok: false, content: staleMsg(elementIndex) };
  }
  if (!objectId) {
    await send('Input.insertText', { text });
    return { ok: true, content: `Typed ${text.length} chars into element [${elementIndex}]` };
  }
  const { editable, type } = await checkEditableAndType(send, objectId);
  if (!editable) {
    return {
      ok: false,
      content: `Element [${elementIndex}] is not a text field — keystrokes would go nowhere. Use tab.click for buttons/links, or call aria.extract to find the actual input.`,
    };
  }
  if (SPECIAL_VALUE_TYPES.has(type)) {
    await send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: SET_NATIVE_VALUE_FN,
      arguments: [{ value: text }],
      returnByValue: true,
    });
    if (opts.submit) await submitViaJs(send, objectId);
    return {
      ok: true,
      content: `Typed ${text.length} chars into element [${elementIndex}]${opts.submit ? ' and submitted' : ''}`,
    };
  }
  if (opts.clear) {
    await send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: SET_NATIVE_VALUE_FN,
      arguments: [{ value: '' }],
      returnByValue: true,
    });
  }
  await send('Input.insertText', { text });
  let retriedClear = false;
  const actual = await readValue(send, objectId);
  if (actual !== text && actual.length > text.length && actual.includes(text)) {
    await send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: SET_NATIVE_VALUE_FN,
      arguments: [{ value: '' }],
      returnByValue: true,
    });
    await send('Input.insertText', { text });
    retriedClear = true;
  }
  if (opts.submit) await submitViaJs(send, objectId);
  const retryNote = retriedClear ? ' (retried after leftover content was detected)' : '';
  return {
    ok: true,
    content: `Typed ${text.length} chars into element [${elementIndex}]${opts.submit ? ' and submitted' : ''}${retryNote}`,
  };
}
```

Add `SendCmd` to the existing `withCdp` import at the top of the file:

```ts
import { withCdp, type SendCmd } from './lifecycle';
```

Now replace the entire `tabTypeTool` definition (lines 358-440 in the current file) with:

```ts
export const tabTypeTool: ToolDefDescriptor<{ tabId: number; elementIndex: number; text: string; clear?: boolean; submit?: boolean }> = {
  name: 'tab.type',
  description:
    'Type text into a field by ARIA tree index. clear=true wipes existing content first. submit=true submits the form / presses Enter afterward — use this to run a search box (clicking the box does NOT submit). Requires click-only tier.',
  argsSchema: z.object({
    tabId: z.number().int(),
    elementIndex: z.number().int().positive(),
    text: z.string(),
    clear: z.boolean().optional(),
    submit: z.boolean().optional(),
  }),
  async dispatch({ tabId, elementIndex, text, clear, submit }, ctx) {
    const url = await tabUrl(tabId);
    assertCanAct(url, 'click-only', ctx.settings.domainTiers, ctx.settings.bypassDomainTiers);
    const backendNodeId = await resolveBackendId(tabId, elementIndex);
    const result = await withCdp(tabId, async (send) => {
      await send('DOM.enable');
      return fillOneFieldWithSend(send, backendNodeId, elementIndex, text, { clear, submit });
    });
    if (!result.ok) return result;
    clearExtractionCache(tabId);
    return result;
  },
};
```

- [ ] **Step 3: Run the existing tests to confirm the refactor changed nothing observable**

Run: `cd extension && npx vitest run tests/unit/actions_readback.test.ts`
Expected: PASS — the same tests from Step 1, now against the refactored code. If any fail, the extraction dropped or reordered a branch; compare against the original `tabTypeTool.dispatch` body (the 10 test cases each pin a specific branch — the failure message will point at which one).

- [ ] **Step 4: Full verification**

Run: `cd extension && npm run typecheck && npm run build && npm test`
Expected: typecheck clean, build succeeds, all tests pass (same total count as before this task — this step adds no new tests, so the count must be identical, not just "still green").

- [ ] **Step 5: Commit**

```bash
cd extension
git add src/agent/tools/browser/actions.ts
git commit -m "refactor(actions): extract fillOneFieldWithSend from tab.type

Pulls tab.type's per-field CDP logic (native-setter clear, the
date/time/color/range branch, read-back-verify) into a helper that
takes an already-open connection, so a future batch-fill tool can run
several fields through one shared withCdp instead of N concurrent
attach/detach cycles on the same tab. tab.type's own behavior and
withCdp usage (one attach/detach per call) are unchanged -- this is a
pure extraction, verified by the existing 10 tab.type tests passing
unmodified."
```

---

### Task 2: Add the `tab.fill_many` tool

**Files:**
- Modify: `extension/src/agent/tools/browser/actions.ts` (add `tabFillManyTool`, after `tabTypeTool`)
- Test: `extension/tests/unit/actions_readback.test.ts` (new `describe` block)

- [ ] **Step 1: Write the failing tests**

Add this new `describe` block to `extension/tests/unit/actions_readback.test.ts`, after the existing `describe('action tools — read-back verification (no phantom success)', ...)` block closes (at the end of the file):

```ts
describe('tab.fill_many — batches known fields into one dispatch', () => {
  let origDebugger: typeof chrome.debugger;
  let origGet: typeof chrome.tabs.get;
  let fieldReadback: Record<number, string>;
  let editableOverride: Record<number, boolean>;

  beforeEach(() => {
    origDebugger = chrome.debugger;
    origGet = chrome.tabs.get;
    fieldReadback = {};
    editableOverride = {};
    chrome.tabs.get = ((id: number, cb: (t: unknown) => void) =>
      cb({ id, url: 'https://shop.example/', status: 'complete' })) as unknown as typeof chrome.tabs.get;
    chrome.debugger = {
      attach: (_t: unknown, _v: unknown, cb: () => void) => cb(),
      detach: (_t: unknown, cb: () => void) => cb(),
      sendCommand: (
        _t: unknown,
        method: string,
        params: { functionDeclaration?: string } | undefined,
        cb: (r?: unknown) => void,
      ) => {
        if (method === 'DOM.resolveNode') return cb({ object: { objectId: 'o1' } });
        if (method === 'Runtime.callFunctionOn') {
          const fn = String(params?.functionDeclaration ?? '');
          if (fn.includes('isConnected')) return cb({ result: { value: true } });
          if (fn.includes('isContentEditable')) {
            // resolveBackendId is mocked to always return 42 regardless of elementIndex, so
            // distinguish fields by which readback/editable override was set most recently --
            // the test below sets these right before dispatching each field's expectation.
            return cb({ result: { value: { editable: true, type: '' } } });
          }
          if (fn.includes('this.value||')) return cb({ result: { value: '' } });
          return cb({ result: {} });
        }
        cb({});
      },
    } as unknown as typeof chrome.debugger;
  });
  afterEach(() => {
    chrome.debugger = origDebugger;
    chrome.tabs.get = origGet;
  });

  const ctx = () =>
    ({ settings: { domainTiers: { 'shop.example': 'click-only' } }, signal: undefined }) as unknown as ToolContext;

  it('fills every field and reports aggregate success', async () => {
    const res = await tabFillManyTool.dispatch(
      { tabId: 5, fields: [{ elementIndex: 1, text: 'Jane Doe' }, { elementIndex: 2, text: 'jane@example.com' }] },
      ctx(),
    );
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/\[1\] filled/);
    expect(res.content).toMatch(/\[2\] filled/);
  });

  it('rejects a single-field array at the schema level (tab.type is the right tool below 2 fields)', () => {
    const parsed = tabFillManyTool.argsSchema.safeParse({ tabId: 5, fields: [{ elementIndex: 1, text: 'x' }] });
    expect(parsed.success).toBe(false);
  });

  it('refuses on a read-only domain before touching any field', async () => {
    const readOnlyCtx = { settings: { domainTiers: { 'shop.example': 'read-only' } }, signal: undefined } as unknown as ToolContext;
    await expect(
      tabFillManyTool.dispatch({ tabId: 5, fields: [{ elementIndex: 1, text: 'a' }, { elementIndex: 2, text: 'b' }] }, readOnlyCtx),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npx vitest run tests/unit/actions_readback.test.ts -t "tab.fill_many"`
Expected: FAIL with `tabFillManyTool is not defined` (or an import error) — the tool doesn't exist yet.

- [ ] **Step 3: Add the `tabFillManyTool` definition**

In `extension/src/agent/tools/browser/actions.ts`, add this immediately after the `tabTypeTool` definition (after its closing `};`):

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
    assertCanAct(url, 'click-only', ctx.settings.domainTiers, ctx.settings.bypassDomainTiers);
    const results = await withCdp(tabId, async (send) => {
      await send('DOM.enable');
      const out: Array<{ ok: boolean; content: string }> = [];
      for (const f of fields) {
        const backendNodeId = await resolveBackendId(tabId, f.elementIndex);
        out.push(await fillOneFieldWithSend(send, backendNodeId, f.elementIndex, f.text));
      }
      return out;
    });
    if (results.some((r) => r.ok)) clearExtractionCache(tabId); // at least one field actually changed the page
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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && npx vitest run tests/unit/actions_readback.test.ts`
Expected: PASS — all tests in the file, including the 3 new `tab.fill_many` cases and the still-unmodified `tab.type`/`tab.click`/`tab.select`/`tab.scroll` ones from Task 1.

- [ ] **Step 5: Commit**

```bash
cd extension
git add src/agent/tools/browser/actions.ts tests/unit/actions_readback.test.ts
git commit -m "feat(actions): add tab.fill_many for batching known text fields

Fills 2+ fields in one dispatch (one model turn) instead of one
tab.type call per field -- the multi-round-trip-heavy pattern for
form-fill, where every field is already visible in the same page
snapshot the model is reasoning from. Runs every field through one
shared withCdp (not N concurrent ones -- chrome.debugger attach is
exclusive per tab) using the same fillOneFieldWithSend logic tab.type
uses, so there is exactly one implementation of 'fill this field
correctly.' No submit option, deliberately -- job-apply's
never-auto-submit guarantee is prompt-enforced only, and this tool
must not add a second way to trip it.

See docs/superpowers/specs/2026-07-05-form-fill-batching-design.md."
```

---

### Task 3: Register the tool, update the executor prompt, final verification

**Files:**
- Modify: `extension/src/agent/tools/index.ts:26` (import), `:53` (registration)
- Modify: `extension/src/agent/prompts/index.ts` (executor system prompt's job-apply-fill line)

- [ ] **Step 1: Register the tool**

In `extension/src/agent/tools/index.ts`, find this import line (around line 26):

```ts
  tabTypeTool,
```

Change it to:

```ts
  tabTypeTool,
  tabFillManyTool,
```

Find this registration line (around line 53):

```ts
  r.register(tabTypeTool);
```

Change it to:

```ts
  r.register(tabTypeTool);
  r.register(tabFillManyTool);
```

- [ ] **Step 2: Update the executor prompt**

In `extension/src/agent/prompts/index.ts`, find this exact line (inside `buildExecutorMessages`'s system prompt, in the `Rules:` list):

```
- To FILL a job application: for each TEXT field, tab.type the matching value from USER PROFILE (below). Use ONLY profile values for personal data — never invent a name, email, etc.
```

Replace it with:

```
- To FILL a job application or form: use tab.fill_many when you can see 2+ empty text fields at once and know every value from USER PROFILE — one call, not one per field. Use tab.type only for a single field, or when you don't yet know every value. Use ONLY profile values for personal data — never invent a name, email, etc.
```

- [ ] **Step 3: Run the full verification suite**

Run: `cd extension && npm run typecheck && npm run build && npm test`
Expected: typecheck clean, build succeeds, all tests pass (same tests as after Task 2 — this task changes registration and prompt text only, no new test-visible behavior).

- [ ] **Step 4: Commit**

```bash
cd extension
git add src/agent/tools/index.ts src/agent/prompts/index.ts
git commit -m "feat(agent): register tab.fill_many, point the executor at it for forms

Prompt change is more directive than a bare 'may' -- the empirical
test run during design showed the model produces correct output when
it batches, but only chose to about 2/3 of the time under softer
wording. Re-check adoption after this ships (informally or via
npm run bench) and iterate on the wording if it's still inconsistent."
```

---

## Plan self-review

**Spec coverage:** New tool + schema ✓ Task 2. `fillOneFieldWithSend` extraction (shared, not duplicated) ✓ Task 1. One shared `withCdp` for the whole batch, not N concurrent ones ✓ Task 2 Step 3 (the `for` loop inside one `withCdp`). No `submit` option ✓ Task 2 Step 3 (schema has no `submit` field at all). Per-field independence (no fail-fast) ✓ Task 2 Step 3 (`for` loop never breaks early). Prompt change ✓ Task 3 Step 2. Registration ✓ Task 3 Step 1. Testing (success, partial-failure story, domain-tier gate, schema min-2) — success ✓, schema-min-2 ✓, domain-tier ✓ in Task 2's tests; partial-failure (one field stale, others still fill) is NOT separately tested — see gap below.

**Gap found:** the spec's Testing section calls for a "one field fails, others succeed" case; Task 2's test list above only covers all-succeed, schema rejection, and the domain-tier gate. Fixing inline: add a fourth test to Task 2 Step 1's block —

```ts
  it('keeps filling the rest of the batch after one field is stale, and reports which one failed', async () => {
    let call = 0;
    const origSend = chrome.debugger.sendCommand;
    chrome.debugger.sendCommand = ((t: unknown, method: string, params: unknown, cb: (r?: unknown) => void) => {
      if (method === 'Runtime.callFunctionOn' && String((params as { functionDeclaration?: string })?.functionDeclaration ?? '').includes('isConnected')) {
        call += 1;
        return cb({ result: { value: call !== 1 } }); // first field's connectivity check reports detached; rest report connected
      }
      return (origSend as typeof chrome.debugger.sendCommand)(t as chrome.debugger.Debuggee, method, params as never, cb);
    }) as typeof chrome.debugger.sendCommand;
    const res = await tabFillManyTool.dispatch(
      { tabId: 5, fields: [{ elementIndex: 1, text: 'a' }, { elementIndex: 2, text: 'b' }] },
      ctx(),
    );
    expect(res.ok).toBe(false); // aggregate fails since not every field succeeded
    expect(res.content).toMatch(/\[1\].*FAILED/s);
    expect(res.content).toMatch(/\[2\] filled/);
  });
```

Add this as a fourth test in Task 2 Step 1's block, before the closing `});` of the `describe`. It must still pass in Task 2 Step 4's run.

**Placeholder scan:** no TBD/TODO; every step has complete, real code (full function bodies, exact line numbers, exact commands).

**Type consistency:** `fillOneFieldWithSend`'s signature (`send: SendCmd, backendNodeId: number, elementIndex: number, text: string, opts: {clear?, submit?}`) is used identically in both call sites (`tabTypeTool`'s wrapper in Task 1, `tabFillManyTool`'s loop in Task 2). `ToolDefDescriptor<{tabId, fields: Array<{elementIndex, text}>}>` in Task 2's type declaration matches the `argsSchema`'s shape exactly (Zod's inferred type and the explicit generic agree field-for-field).
