# Bypass domain-access tiers (opt-in checkbox)

**Date:** 2026-06-23
**Status:** Approved (conversation)

> **Update (2026-07-01, prod-readiness review Task 8):** the tier system described below
> (`read-only`/`click-only`/`full-action`) was later collapsed to **two** tiers,
> `read-only`/`click-only` — `full-action` no longer exists in code (it was byte-identical
> to `click-only` in enforcement, so it carried no distinct behavior). The bypass mechanism
> itself is unaffected: it still relaxes whichever site-access tiers exist, and the protocol
> blocklist still applies regardless. The rest of this document is left as written on
> 2026-06-23 and describes the three-tier system that was true at the time.

## Problem

The domain-tier safety gate (every site starts **read-only**; the user must upgrade a host to click-only/full-action before the agent can click/type/submit) blocks the agent even when a click is needed purely to *read* information. Live evidence — goal *"Find the phone number and opening hours of the British Museum"*:

1. Agent opened `britishmuseum.org/visit`; a **cookie-consent dialog** overlaid the content.
2. The harness's auto-consent-dismiss (`orchestrator.autoObserveAfterNavigation` → `findConsentDismiss` → dismiss) is gated by `canActUrl` (requires ≥ click-only). The site was read-only, so **it never fired**.
3. The executor's own `tab.click` to dismiss/reveal then threw: *"Cannot click-only on www.britishmuseum.org (current tier: read-only)."*
4. Blocked behind the cookie wall, the agent returned **partial** ("phone: not listed") — the number is likely on the site but was unreachable.

The find-contact recipe behaved correctly (it declined to fabricate a number); the *only* failure was domain access blocking a read-only-intent interaction. Requiring the user to pre-authorize every host in Settings is friction that defeats simple info-gathering.

## Principle

Add a single opt-in escape hatch, **default off** so "safe by default" is preserved for anyone who doesn't touch it. Keep the entire tier mechanism intact (reversible, still available to anyone who wants per-site control). The bypass relaxes the *site-access tiers* only — it does **not** relax the hard protocol blocklist.

## Design — `bypassDomainTiers` setting

**Setting:** `Settings.bypassDomainTiers?: boolean`, `DEFAULT_SETTINGS.bypassDomainTiers = false`.

**UI (SettingsPanel.tsx):** a checkbox near the Domain-tiers section:
> ☐ **Let the agent click, type, and submit on any site (skip per-site approval)**
> With this on, the agent can take actions on any page without asking first — including forms and purchases. Reading pages was never restricted.

**Wiring:**
- `assertCanAct(url, required, tiers, bypass = false)`: when `bypass` is true, **skip the tier comparison** — but still call `isBlockedUrl(url)` and throw on a blocked scheme. The 4 call sites (`actions.ts` ×3, `upload.ts` ×1) pass `ctx.settings.bypassDomainTiers`.
- `orchestrator.canActUrl(url)`: return `true` when `bypassDomainTiers` is on (so auto-consent-dismiss fires on any site), else the existing tier check.

**Safety boundary kept (deliberate):** the bypass relaxes only the read-only/click-only/full-action tiers. `isBlockedUrl` (`file:`, `chrome:`, `chrome-extension:`, `javascript:`, `data:`, `blob:`, `about:`, `view-source:`, `ws:`/`wss:`) stays enforced regardless — those are security guards (injection, local-disk, browser-internals), not "domain access." The bypass means "act on any normal website," not "touch dangerous URL schemes."

## Trade-off (stated plainly)

With it **on**, the agent can submit forms / click "buy"/"delete" on any site with no checkpoint — the intended power, and the real risk. With it **off** (default), behavior is byte-identical to today. Reversible anytime by unchecking. Page *reading* was never gated and is unaffected either way.

## Explicitly NOT doing

- Not removing the tier system (it stays — defaulted-on bypass would lose the optionality; full removal loses reversibility + the safety positioning).
- Not relaxing `isBlockedUrl`.
- Not auto-enabling the bypass. Default off.
- Not a per-action consent prompt (heavier; the checkbox is what was asked for).

## Testing (TDD)

- `assertCanAct`: with `bypass=true`, a read-only host does NOT throw for `click-only` (tier skipped); with `bypass=true`, a `javascript:`/`file:` URL STILL throws (blocklist enforced); with `bypass=false`, existing behavior unchanged (read-only host throws). Existing domain_tiers tests stay green.
- Full suite + tsc + build green.
- Live proof: re-run the British Museum goal with the box checked → the consent wall is auto-dismissed, the agent reads the real page and reports the actual phone/hours (not "not listed").

## Implementation notes

Small, additive. Touches `shared/messages.ts`, `safety/domain_tiers.ts`, `tools/browser/actions.ts`, `tools/browser/upload.ts`, `orchestrator.ts` (`canActUrl`), `sidepanel/components/SettingsPanel.tsx`. TDD; branch → ff-merge.
