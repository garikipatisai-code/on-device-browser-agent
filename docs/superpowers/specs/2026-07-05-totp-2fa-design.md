# TOTP / 2FA autofill — design

## Motivation

Some sites require a time-based one-time code (TOTP, RFC 6238 — the 6-digit code from an authenticator app) as a second factor during login. Today the agent has no way to get past that screen at all; the run just stalls. This spec lets the agent compute and enter that code itself, for a domain the user has explicitly configured — the same trust model as job-apply's stored profile autofill (the user hands the agent real, sensitive data once; the agent uses it, never invents it, never exposes it).

**Ethical framing, stated once so it doesn't need re-litigating:** this is not the same category as the anti-bot-pause work. A CAPTCHA/Cloudflare wall exists to prove you're *not* the account owner's automated tool — defeating it is what this project permanently declined to build. A TOTP code exists to prove the person logging in *has access to an account they already own* — the user providing their own secret for their own account is the same authorization model as typing their own saved password. Auto-computing it is the accepted design here, confirmed directly with the user; it is not the same request as anti-bot bypass and neither un-blocks nor implies the other.

## Scope

In scope:
1. A new `agent/totp.ts`: pure functions — parse an `otpauth://` URI, base32-decode a secret, compute the current TOTP code (RFC 6238/4226).
2. A new tool `totp.get_code({tabId})`: looks up the stored secret for the current tab's domain, computes the current code, returns it. Domain-tier gated like every other mutating tool.
3. Settings storage: `Settings.totpSecrets: Record<string, TotpSecretEntry>`, keyed by host — same shape as `Settings.domainTiers`. A new Settings UI section to add one (paste an `otpauth://` URI, pick the domain).
4. Executor prompt guidance: recognize a 2FA/verification-code prompt on a domain with a stored secret, call `totp.get_code`, then `tab.type` the result.

Out of scope (see Non-goals): HOTP (counter-based, not time-based), non-default TOTP parameters (any algorithm/digit-count/period other than the SHA1/6-digit/30-second de facto standard essentially every real service uses), SMS/email codes (not computable — no secret exists to compute from), and a live human-handoff fallback for a domain with no stored secret (the user explicitly chose the stored-secret model over this in brainstorming; if it's wanted later, that's its own design).

## Why a dedicated tool, not context injection

Two ways to get the model a code:

- **A — a `totp.get_code` tool, called right when needed.** The code is computed in the same turn (or the very next one) it gets typed.
- **B — inject the current code into context upfront**, the same way `USER PROFILE` already is (`agent/profile.ts`'s `renderProfileBlock`).

**Decision: A.** TOTP codes are valid for ~30 seconds (the RFC 6238 default step). This project's own executor turns measured 12-25+ seconds each earlier this session (real `gemma4:e4b` calls, not an estimate) — a code computed at prompt-build time and injected upfront risks expiring before the model gets around to typing it, especially if the model needs even one more turn to first recognize the field or handle something else on the page first. Computing it on demand, in the tool call immediately preceding the `tab.type` that uses it, minimizes that window to essentially nothing. This is the same category of reasoning as the form-fill-batching spec's empirical-evidence-over-assumption approach, just via direct latency math instead of a live-model test — the 30-second constraint is fixed and known, so no experiment was needed to see the risk.

**Also decided: `totp.get_code` returns only the code, never combined with `tab.type` into one call.** A combined tool would save one more round-trip, but TOTP's ~30-second window comfortably covers one extra turn (unlike the multi-minute risk that motivated form-fill batching's speed argument) — bundling two genuinely different actions (compute a secret-derived code; type into a specific field) into one tool trades a real, well-understood safety/isolation property (the tool that touches the secret never also decides which DOM element to touch) for a marginal latency win that isn't needed here.

## Storage

`Settings.totpSecrets: Record<string, TotpSecretEntry>`, added to `shared/messages.ts` alongside `domainTiers` (same host-keyed shape, same persistence — `chrome.storage.local`, never `sync`, so a secret never leaves the device even via the user's own Google account sync):

```ts
export interface TotpSecretEntry {
  /** Base32, as pasted from the otpauth:// URI's `secret` param. Raw, never sent to the LLM. */
  secret: string;
  /** Display label only (the URI's issuer/account name) -- not used in the TOTP computation. */
  label: string;
}
```

Added to `Settings`:

```ts
totpSecrets?: Record<string, TotpSecretEntry>;
```

`DEFAULT_SETTINGS.totpSecrets = {}` (matching `domainTiers: {}`).

**Never sent to the model, ever — stronger than profile data's redaction-at-the-boundary-only rule.** Profile data is deliberately sent to the LLM unredacted (it has to be, for the model to fill a field with it) and only scrubbed going into IndexedDB/UI events at the boundary (`docs/architecture-map.md`'s Safety layer section). TOTP secrets are different: the model never needs to see the secret itself, only the computed code, so the secret should never enter a prompt, an `emit()` payload, or a tool argument at all — not "redacted before persistence," genuinely never present in that data path in the first place. `totp.get_code`'s tool result contains only the 6-digit code and nothing else; the tool's *argument* schema has no secret-shaped field for a model to echo back either.

### Settings UI

A new "Two-factor codes (optional)" card in `SettingsPanel.tsx`, matching the existing "Domain access" card's list-of-entries pattern:
- A text input for pasting an `otpauth://` URI, a text input for which domain it's for (e.g. `github.com`), an "Add" button — parses the URI via `parseOtpAuthUri` (below) on Add; a parse error (bad URI, non-TOTP type, non-default algorithm/digits/period) shows inline instead of silently storing something that would compute a wrong code.
- Below that, the existing entries listed by domain + the URI's display label, each with a Delete button (mirroring the domain-tier rows) — never displaying the raw secret again once added, matching how the API-key field elsewhere in Settings is `type="password"` and never round-trips back to plaintext display.

## `agent/totp.ts` (pure functions, no side effects — mirrors `agent/profile.ts`'s shape)

```ts
export interface ParsedTotp {
  secret: string; // base32, as-is
  label: string;  // issuer/account, for display only
}

/** Parses an otpauth://totp/... URI. Returns null (with a reason) for anything this project
 *  doesn't support, rather than silently computing a code that would be wrong. */
export function parseOtpAuthUri(uri: string): { ok: true; value: ParsedTotp } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    return { ok: false, reason: 'Not a valid URI.' };
  }
  if (url.protocol !== 'otpauth:') return { ok: false, reason: 'Not an otpauth:// URI.' };
  if (url.host !== 'totp') return { ok: false, reason: 'Only time-based (totp) codes are supported, not counter-based (hotp).' };
  const secret = url.searchParams.get('secret');
  if (!secret) return { ok: false, reason: 'URI has no secret parameter.' };
  const algorithm = url.searchParams.get('algorithm');
  if (algorithm && algorithm.toUpperCase() !== 'SHA1') {
    return { ok: false, reason: `Only SHA1 is supported (URI specifies ${algorithm}).` };
  }
  const digits = url.searchParams.get('digits');
  if (digits && digits !== '6') {
    return { ok: false, reason: `Only 6-digit codes are supported (URI specifies ${digits}).` };
  }
  const period = url.searchParams.get('period');
  if (period && period !== '30') {
    return { ok: false, reason: `Only the standard 30-second period is supported (URI specifies ${period}).` };
  }
  const label = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || url.searchParams.get('issuer') || 'Unnamed';
  return { ok: true, value: { secret, label } };
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 decode. Case-insensitive, ignores '=' padding and whitespace (how TOTP
 *  secrets are commonly copy-pasted). Throws on a character outside the alphabet. */
export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[=\s]/g, '');
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

/** RFC 6238 TOTP over RFC 4226 HOTP, fixed at SHA1/6-digits/30s (the only shape this project
 *  supports -- see parseOtpAuthUri). `unixSeconds` is injectable for deterministic testing;
 *  defaults to real time for actual use. */
export async function computeTotpCode(secretBytes: Uint8Array, unixSeconds: number = Math.floor(Date.now() / 1000)): Promise<string> {
  const counter = Math.floor(unixSeconds / 30);
  const counterBytes = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    counterBytes[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBytes));
  const offset = sig[19] & 0xf;
  const code =
    ((sig[offset] & 0x7f) << 24) |
    ((sig[offset + 1] & 0xff) << 16) |
    ((sig[offset + 2] & 0xff) << 8) |
    (sig[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}
```

`base32Decode`/`computeTotpCode` use no extension APIs (`crypto.subtle` is standard Web Crypto, available in any modern JS runtime including the vitest/happy-dom test environment) — both are directly unit-testable with plain Node/happy-dom, no `chrome.*` mocking needed.

## The tool (`agent/tools/browser/totp.ts`)

```ts
export const totpGetCodeTool: ToolDefDescriptor<{ tabId: number }> = {
  name: 'totp.get_code',
  description:
    'Get the current 6-digit two-factor/verification code for the site open in this tab, if a TOTP secret is stored for its domain (Settings → Two-factor codes). Returns just the code -- type it with tab.type immediately after, since it expires in about 30 seconds. Fails with a clear message if no secret is stored for this domain.',
  argsSchema: z.object({ tabId: z.number().int() }),
  async dispatch({ tabId }, ctx) {
    const url = await tabUrl(tabId);
    assertCanAct(url, 'click-only', ctx.settings.domainTiers, ctx.settings.bypassDomainTiers);
    const host = hostFor(url); // existing helper in agent/safety/domain_tiers.ts
    const entry = ctx.settings.totpSecrets?.[host];
    if (!entry) {
      return { ok: false, content: `No TOTP secret stored for ${host}. Add one in Settings → Two-factor codes, or ask the user for the code.` };
    }
    const code = await computeTotpCode(base32Decode(entry.secret));
    return { ok: true, content: code };
  },
};
```

`hostFor` is the same URL→host normalization `domain_tiers.ts` already uses for `domainTiers` lookups (matching by registrable host, not full URL) — reusing it, not a second implementation of URL-to-host matching.

## Prompt change (`prompts/index.ts`, executor system prompt)

Add one line to the `Rules:` list, near the existing job-apply-fill line:

> If the page asks for a verification/2FA/authenticator code, call totp.get_code first — if it returns a code, tab.type it immediately (it expires in ~30s). If it says no secret is stored, report that to the user via finish rather than guessing a code.

## Testing

New `tests/unit/totp.test.ts`:
- `computeTotpCode` against RFC 6238's own published test vectors (Appendix B) — the reference secret is the ASCII string `"12345678901234567890"` (as raw bytes, not base32 — decoupling the algorithm test from the base32 test), the reference implementation's 8-digit outputs' last 6 digits are this project's 6-digit answer (mathematically identical: `x % 10^8 % 10^6 == x % 10^6`):
  - `computeTotpCode(secretBytes, 59)` → `'287082'`
  - `computeTotpCode(secretBytes, 1111111109)` → `'081804'`
  - `computeTotpCode(secretBytes, 1111111111)` → `'050471'`
  - `computeTotpCode(secretBytes, 1234567890)` → `'005924'`
- `base32Decode` round-trips a known RFC 4648 test vector, and throws on an invalid character.
- `parseOtpAuthUri`: a valid `totp` URI succeeds; `hotp` is rejected with a clear reason; a non-`SHA1`/non-`6`-digit/non-`30`-period URI is rejected with the specific offending parameter named; a missing `secret` param is rejected; a non-URI string is rejected without throwing.
- `totpGetCodeTool.dispatch`: returns the computed code for a domain with a stored secret; returns the "no secret stored" message (not a throw) for one without; refuses on a `read-only` domain before computing anything (mirroring every other action tool's domain-tier test).

## Non-goals

- **HOTP** (counter-based one-time codes). Rejected at parse time with a clear reason — this project only supports the time-based flavor essentially every real 2FA setup uses.
- **Non-default TOTP parameters** (SHA256/SHA512, 7/8-digit codes, non-30s periods). All rejected at parse time by name — a small, real minority of services use these, and silently computing a wrong code is worse than a clear "not supported" at setup time.
- **SMS/email 2FA codes.** Not computable — there is no secret to derive them from. Out of scope structurally, not by choice.
- **A live human-handoff fallback** (pause and ask the user for a code) for a domain with no stored secret. The user explicitly chose the stored-secret model over this during brainstorming. `totp.get_code`'s "no secret stored" message hands this back to the model's own `finish`-and-report behavior, not a new pause mechanism — revisit only as its own design if this turns out to be commonly needed.
- **Combining `totp.get_code` and `tab.type` into one call.** See "Why a dedicated tool" above — kept as two calls deliberately, isolation over one saved round-trip.
