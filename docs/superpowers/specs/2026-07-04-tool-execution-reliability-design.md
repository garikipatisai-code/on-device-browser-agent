# Tool execution reliability — design

## Motivation

A comparative review of this project's action-execution layer against other browser-automation approaches found that this project's `agent/tools/browser/actions.ts` is missing a specific, narrow class of robustness: verifying that an action actually produced its intended effect before reporting success, and special-casing input shapes (`date`/`color`/`range`, React-controlled fields) that don't behave correctly under naive text-insertion or property assignment. This spec ports the specific, narrow techniques worth having — not any external project's architecture, CDP usage pattern, or anything else.

This is exclusively a reliability improvement to actions the agent is already allowed to take. It does not add any new capability, expand the safety-tier surface, or touch anything related to anti-bot/CAPTCHA challenges (explicitly out of scope — see Non-goals).

## Scope

In scope — all confined to `extension/src/agent/tools/browser/actions.ts` and `extension/src/agent/tools/browser/aria.ts`, plus new/extended tests in `extension/tests/unit/`:

1. `tab.click` — checkbox/radio/switch read-back-and-verify-and-retry.
2. `tab.click` — occlusion awareness on the coordinate-fallback path.
3. `tab.type` — native-setter bypass for the `clear` step.
4. `tab.type` — type-aware branch for date/time/color/range inputs.
5. `tab.type` — read-back-and-verify after typing, with one retry.
6. `tab.select` — support for ARIA `combobox`+`listbox` custom dropdowns, alongside the existing native `<select>` path.

Out of scope for this spec:
- Any orchestrator, safety-tier, domain-tier, or side-panel UI change.
- CAPTCHA/anti-bot-challenge detection or bypass of any kind (see Non-goals).
- `redact.ts`'s persistence-boundary PII redaction (unchanged) — the password-value concern raised during research turned out, on reflection during this design, not to need a code change; see "Password values" under Non-goals.
- Generalizing `tab.select` beyond one additional dropdown shape.

## The type-lookup decision

Items 4 and 6 (and an earlier draft of this spec that also included password-value redaction in `aria.ts`) all run into the same fact: neither `actions.ts` nor `aria.ts` currently knows an element's HTML `type` attribute — `aria.ts`'s `AxNode`/`SimplifiedNode` (`aria.ts:3-23`) carry only accessibility *role* (`textbox`, `checkbox`, ...), which is semantic and doesn't distinguish `<input type=date>` from a plain text field.

Two ways to get it:

- **A — look it up narrowly, only where needed, only at act time.** `tab.type` already pays for one `Runtime.callFunctionOn` round-trip via the existing `isEditable` check (`actions.ts:71-86`); extend that same JS snippet to also return `.type`/`.tagName`, at zero extra round-trips.
- **B — fetch it for real, in bulk, during perception.** Merge a `DOMSnapshot.captureSnapshot` call into the tree-building step, matched by `backendDOMNodeId`, giving ground-truth `type` for every node in one extra bulk CDP call per `aria.extract`. This is a known pattern for this kind of perception pipeline, and is the only way to make `type` available at *display* time (e.g. rendering a date-format hint directly in the ARIA string, or suppressing a password value from ever appearing in it).

**Decision: A.** `aria.ts`'s escalating-trim/budget logic (`capTree`, `aria.ts:187-257`) is the most carefully-tuned code in this subsystem — a second bulk CDP call and a new node-merge step is real added surface area and regression risk for a need that, on inspection, only one item (date-input typing) actually has. Ship the cheap, zero-extra-round-trip version now; revisit only if a real failure mode shows up in the bench or in practice (matches this codebase's existing "evidence over a-priori design" pattern — `docs/architecture-map.md`, Recurring design principles §2).

## Item designs

### 1. `tab.click` — checkbox/radio/switch verify-and-retry

Current: `tabClickTool.dispatch` (`actions.ts:88-124`) resolves the node, scrolls it into view, checks staleness, calls `this.click()`, and reports success the instant the CDP call doesn't throw — no check that anything changed.

New: before clicking, run one small JS check against the resolved `objectId`:

```js
function(){ try {
  var t=(this.type||'').toLowerCase();
  if(t==='checkbox'||t==='radio') return this.checked;
  var r=(this.getAttribute&&this.getAttribute('role'))||'';
  if(r==='switch'||r==='checkbox'||r==='menuitemcheckbox') return this.getAttribute('aria-checked')==='true';
  return null; // not a toggle — no verification applies
} catch(e){ return null; } }
```

If it returns non-null, capture `before`. After the click, re-run it as `after`. If `before === after` (didn't toggle), retry once by clicking the element's associated `<label for=id>` (or ancestor `<label>`) instead of the element itself, then re-check. Report the retry in the success message if it was needed (e.g. `"Clicked element [7] (via associated label — direct click did not toggle it)"`), so a recurring need-to-retry pattern is visible in the timeline rather than silent.

Non-toggle elements (`null` on the first check) skip all of this and behave exactly as today — this only adds cost on the checkbox/radio/switch path.

### 2. `tab.click` — occlusion check on the coordinate fallback

Current: when `DOM.resolveNode` fails to produce an `objectId` (`actions.ts:113-117`), the tool dispatches raw `Input.dispatchMouseEvent` at the box-model center with no check of what's actually at that point.

**Correction from the design presented in conversation:** an in-page occlusion check (`document.elementFromPoint` + containment) needs a JS object reference to compare against — but this fallback path exists *precisely because* we have none (that's why `objectId` is undefined here). Comparing `elementFromPoint`'s result against a reference we don't have isn't implementable as described; a JS-side check is the wrong tool for this path.

New design: use CDP's `DOM.getNodeForLocation({x, y})` — a native CDP command that returns the `backendNodeId` actually at a given point, no in-page object reference required. Compare its result to the `backendNodeId` we already have (from `resolveBackendId`, at the top of `dispatch`). If they differ, the point is covered by something else; return `{ok: false}` with an actionable message ("element [n] is covered by another element at that position — call aria.extract to see what's on top, or scroll it into view") instead of clicking whatever is actually on top and reporting phantom success. If `DOM.getNodeForLocation` itself throws (some pages/points can't be resolved this way), fall back to today's unconditional dispatch rather than blocking the action — this check should only prevent a click when it has positive evidence of occlusion, never when it's merely uncertain.

This path is rare (only hit when `DOM.resolveNode` itself fails), so this is a small, self-contained addition with a narrow blast radius.

### 3. `tab.type` — native-setter clear

Current (`actions.ts:152-158`): the `clear` branch does `this.value = ""` — a raw property assignment. On a React-controlled (or similar framework-controlled) field, this can be silently reverted on the next render because it bypasses the framework's tracked-value setter.

New: replace with the property-descriptor setter (the standard technique for setting a value on a framework-controlled input without triggering the framework's own value-tracking interception):

```js
function() { try {
  var proto = this.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(this, '');
  this.dispatchEvent(new Event('input', {bubbles:true}));
} catch(e) {} }
```

Falls back to today's plain assignment inside the same `try` if the descriptor lookup throws (e.g. an unexpected element shape) — never a regression versus current behavior, only an upgrade path.

### 4. `tab.type` — date/time/color/range branch

Using the type lookup from the "type-lookup decision" (Option A): extend the existing `isEditable` JS snippet (`actions.ts:71-86`) to also return `type`/`tagName` in the same round-trip. If `type` is one of `date`, `time`, `datetime-local`, `month`, `week`, `color`, `range`, skip `Input.insertText` entirely (it does not reliably work on these input shapes) and instead assign the value via the same native-setter pattern as item 3, using the caller-supplied `text` verbatim (the model is responsible for supplying it in the input's expected format — e.g. `YYYY-MM-DD` for `date` — no format-hint synthesis is in scope here, since that would require the type-lookup-at-perception-time Option B this spec explicitly defers).

### 5. `tab.type` — read-back-and-verify

After the existing `Input.insertText` call (`actions.ts:159`) — for the non-special-cased (plain text) path only — read `this.value` back. If it doesn't equal `text` and specifically looks like concatenation (the read-back value contains `text` as a substring but is longer than it), the `clear` step didn't fully work; retry once via the native-setter clear (item 3) followed by a fresh `Input.insertText`, then accept whatever the second attempt produces without a further loop. If the read-back simply doesn't match for some other reason (e.g. an input mask reformatted it, like a phone-number field inserting dashes), leave it as-is and report success as today — this check is specifically for the concatenation failure mode, not a general "does the value look right" judgment call the model should still make itself.

### 6. `tab.select` — ARIA combobox+listbox support

Current (`actions.ts:183-224`): only acts on real `<select>` elements; anything else returns `{ok:false, content: "... (target is not a <select>.)"}`.

New: when the resolved node's `tagName !== 'SELECT'`, check for `role="combobox"` with an `aria-controls` or `aria-owns` attribute. If present:
1. Expand it — dispatch `focus` then `click` on the combobox element, wait briefly (~500ms settle wait for JS-rendered popups, a common pattern for this kind of async UI).
2. Read the referenced listbox's options (by id from `aria-controls`/`aria-owns`), matching `value` against each option's trimmed text content case-insensitively (not exact `.value` matching, since ARIA listbox options don't have a native `value` attribute the way `<option>` does).
3. Click the matching option.
4. Verify by re-reading the combobox's displayed text/value; if unchanged, collapse (dispatch `Escape`) and report failure with the available option texts, same shape as the existing native-`<select>` failure message.
5. Collapse via `Escape` if still expanded after a successful selection, so the tool doesn't leave a popup open behind it.

This is the most complex item in this spec (multi-step: expand → match → click → verify → collapse, versus a single verify-and-retry elsewhere) and the one most likely to need iteration against real sites during implementation. It's additive — the existing native-`<select>` path (lines 204-211) is unchanged; this is a new branch taken only when the resolved node isn't a `<select>`.

## Testing

Extends `extension/tests/unit/actions_readback.test.ts`'s existing pattern exactly: the same `CdpState`-driven `chrome.debugger.sendCommand` stub, matching on CDP method plus a substring of the JS `functionDeclaration`/`expression`. New cases per item:
- A checkbox that toggles on the first click vs. one that doesn't (exercises the label-retry).
- A click whose coordinate-fallback point resolves to an occluding element vs. a clear one.
- A `clear`+type sequence where the naive assign would leave stale content, verifying the retry fires.
- A `type=date` element vs. a plain `type=text` element, verifying the branch is taken correctly.
- A `role=combobox` element vs. a real `<select>` vs. neither, verifying `tab.select` picks the right path (and still fails cleanly on neither).

## Error handling

Every new failure mode returns `{ok: false, content: <actionable message>}` — never a throw — matching the existing house style in this file (the stale/not-editable/invalid-option messages already there). No new error types or exception classes.

## Non-goals

- **CAPTCHA/anti-bot bypass.** Explicitly and permanently out of scope for this and any tool-reliability work — see the conversation record for the reasoning (defeating bot-detection is a different category from making a legitimate action more reliable, regardless of the specific task's intent, and even comparable commercial tools don't ship this locally). A separate detect-and-pause-for-human feature was proposed as the legitimate alternative and deferred to its own spec.
- **Password value redaction in `aria.ts`.** Raised during research as "cheap insurance" against a possible AX-tree value leak, but implementing it correctly requires knowing an element is `type=password` — which is exactly the Option B (bulk `DOMSnapshot` merge) this spec defers. Doing it via a name-based heuristic (checking accessible name for "password"-like text) was considered and rejected here: a heuristic redaction feature that silently fails to catch a real password field is arguably worse than no feature, since it would create false confidence. If this needs solving, it should happen together with the Option B upgrade, as a follow-up, with real verification of whether CDP's `Accessibility.getFullAXTree` actually exposes password values in the first place (unconfirmed either way in the research).
- **Generalizing beyond one extra dropdown shape.** Some comparable tools handle several distinct custom-dropdown shapes; this spec adds ARIA combobox+listbox only, since it's the shape modern component libraries (React-Select, MUI, Radix) most commonly render. Class-based custom dropdowns and ARIA `menu`-shaped ones are not covered.
- **Format-hint synthesis for date inputs.** (e.g. rendering "expected format: YYYY-MM-DD" in the ARIA string.) Requires perception-time type knowledge (Option B), deferred along with it.
