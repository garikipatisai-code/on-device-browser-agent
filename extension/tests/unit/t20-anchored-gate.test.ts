// T20 anchored compact wiring + finish gate + full gate (BRAIN TDD, 0 LLM calls).
// Pins: FACTS+ANCHOR never cut, header-intact over-budget, isFinishAdmissible +
// assertNumbersEntitiesGrounded fail-closed, and flag-gated wiring (off =
// legacy verbatim byte-identical, on = anchored/strict). Documents T18 Q +
// T19 UD gap as scheduler debt (T19 UD bench blocked — no tag, needs approval
// + exact tag). Pure stubs only: no OllamaClient, no fetch, no model calls.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/shared/messages';
import {
  anchoredCompact,
  resolveAnchoredCompaction,
  resolveFinishGate,
} from '@/agent/orchestrator';
import {
  assertNumbersEntitiesGrounded,
  getPostState,
  isFinishAdmissible,
} from '@/agent/verify/grounding';

describe('T20 anchored compact FACTS+ANCHOR never cut (BRAIN TDD)', () => {
  it('keeps FACTS+ANCHOR verbatim under a tiny budget with a huge scratch', () => {
    const facts = 'FACTS-PAYLOAD-austin-1M';
    const anchor = 'ANCHOR-PAYLOAD-same-site-source';
    const out = anchoredCompact({
      goal: 'compare-populations',
      facts,
      anchor,
      scratch: `s-${'s'.repeat(5000)}-tail`,
      maxChars: 120,
    });
    expect(out).toContain(facts);
    expect(out).toContain(anchor);
    expect(out.length).toBeLessThanOrEqual(120);
  });

  it('keeps the scratch PREFIX (head), not the tail', () => {
    const out = anchoredCompact({
      goal: 'g',
      facts: 'f',
      anchor: 'a',
      scratch: 'HEAD-12345-tail-should-truncate-away-67890',
      maxChars: 60,
    });
    expect(out).toContain('HEAD-12345');
  });
});

describe('T20 header-intact over-budget (BRAIN TDD)', () => {
  it('returns the full header intact over budget when facts+anchor alone exceed it', () => {
    const goal = 'compare-populations-goal';
    const facts = `facts-${'F'.repeat(200)}`;
    const anchor = `anchor-${'A'.repeat(200)}`;
    const maxChars = 50;
    const out = anchoredCompact({ goal, facts, anchor, scratch: 'scratch', maxChars });
    expect(out).toContain(facts);
    expect(out).toContain(anchor);
    expect(out).toContain(goal);
    expect(out.startsWith('GOAL: ')).toBe(true);
    // Header-intact means over budget, never cut.
    expect(out.length).toBeGreaterThan(maxChars);
  });
});

describe('T20 fail-closed gates (BRAIN TDD)', () => {
  it('isFinishAdmissible fails closed on missing args/summary', () => {
    const post = getPostState({ passed: true });
    expect(isFinishAdmissible(null, 'page shows $24.99', post).decision).toBe('FAIL_CLOSED');
    expect(isFinishAdmissible(undefined, 'page shows $24.99', post).decision).toBe('FAIL_CLOSED');
    expect(isFinishAdmissible({}, 'page shows $24.99', post).ok).toBe(false);
    expect(
      isFinishAdmissible({ verdict: 'success' }, 'page shows $24.99', post).decision,
    ).toBe('FAIL_CLOSED');
    expect(
      isFinishAdmissible({ verdict: 'success', summary: '   ' }, 'page shows $24.99', post).ok,
    ).toBe(false);
  });

  it('isFinishAdmissible fails closed on ungrounded numbers/entities + post-state fail', () => {
    const okPost = getPostState({ passed: true });
    expect(
      isFinishAdmissible(
        { verdict: 'success', summary: 'The price is $999.99' },
        'the page shows $24.99 in stock',
        okPost,
      ).decision,
    ).toBe('FAIL_CLOSED');
    expect(
      isFinishAdmissible(
        { verdict: 'success', summary: 'Per the Smithsonian Report it is the best pick' },
        'the page shows $24.99 in stock, Logitech mouse',
        okPost,
      ).decision,
    ).toBe('FAIL_CLOSED');
    const args = { verdict: 'success', summary: 'The price is $24.99' };
    const observed = 'the page shows $24.99 in stock';
    expect(isFinishAdmissible(args, observed, getPostState({ passed: false })).ok).toBe(false);
    expect(isFinishAdmissible(args, observed, getPostState(null)).decision).toBe('FAIL_CLOSED');
    expect(isFinishAdmissible(args, observed, null).ok).toBe(false);
    expect(isFinishAdmissible(args, observed, undefined).decision).toBe('FAIL_CLOSED');
  });

  it('assertNumbersEntitiesGrounded fails closed (RE_GROUND) on novel/empty', () => {
    expect(
      assertNumbersEntitiesGrounded('The price is $999.99', 'the page shows $24.99 in stock')
        .decision,
    ).toBe('RE_GROUND');
    expect(
      assertNumbersEntitiesGrounded(
        'Per the Smithsonian Report it is the best pick',
        'the page shows $24.99 in stock, Logitech mouse',
      ).decision,
    ).toBe('RE_GROUND');
    expect(assertNumbersEntitiesGrounded('', 'the page shows $24.99').decision).toBe('RE_GROUND');
    expect(assertNumbersEntitiesGrounded('   ', 'the page shows $24.99').decision).toBe(
      'RE_GROUND',
    );
    // Bare single digits are not data.
    expect(assertNumbersEntitiesGrounded('top 3 picks', 'unrelated page text').decision).toBe(
      'OK',
    );
  });
});

describe('T20 anchoredGate flag default-off (BRAIN TDD)', () => {
  it('defaults anchoredGate to false — safe by default', () => {
    expect(DEFAULT_SETTINGS.anchoredGate).toBe(false);
  });
});

describe('T20 anchoredCompact wiring flag-gated (BRAIN TDD)', () => {
  const base = {
    goal: 'compare-populations',
    facts: 'FACTS-austin-1M',
    anchor: 'ANCHOR-same-site-source',
    scratch: `head-${'x'.repeat(500)}-tail-marker-zzz`,
    maxChars: 120,
  };

  it('off path is legacy verbatim: scratch tail slice, no header, even when grounded', () => {
    for (const enabled of [undefined, false] as const) {
      const out = resolveAnchoredCompaction({ ...base, enabled });
      expect(out).toBe(base.scratch.slice(-base.maxChars));
      expect(out.length).toBeLessThanOrEqual(base.maxChars);
    }
  });

  it('on path wires anchoredCompact: FACTS+ANCHOR preserved, budget respected', () => {
    const out = resolveAnchoredCompaction({ ...base, enabled: true });
    expect(out).toBe(anchoredCompact(base));
    expect(out).toContain(base.facts);
    expect(out).toContain(base.anchor);
    expect(out.length).toBeLessThanOrEqual(base.maxChars);
  });

  it('on path keeps the header intact over budget (never cuts FACTS+ANCHOR)', () => {
    const facts = `facts-${'F'.repeat(200)}`;
    const anchor = `anchor-${'A'.repeat(200)}`;
    const out = resolveAnchoredCompaction({
      goal: 'g',
      facts,
      anchor,
      scratch: 'scratch',
      maxChars: 50,
      enabled: true,
    });
    expect(out).toContain(facts);
    expect(out).toContain(anchor);
    expect(out.length).toBeGreaterThan(50);
  });
});

describe('T20 finish gate wiring flag-gated (BRAIN TDD)', () => {
  const observed = 'the page shows $24.99 in stock Logitech mouse';

  it('off path is legacy verbatim: passthrough with admitted=true, even when ungrounded', () => {
    for (const enabled of [undefined, false] as const) {
      const out = resolveFinishGate({
        verdict: 'success',
        summary: 'The price is $999.99',
        observed,
        postPassed: true,
        enabled,
      });
      expect(out.verdict).toBe('success');
      expect(out.summary).toBe('The price is $999.99');
      expect(out.admitted).toBe(true);
    }
  });

  it('on path admits a grounded finish verbatim', () => {
    const out = resolveFinishGate({
      verdict: 'success',
      summary: 'The price is $24.99',
      observed,
      postPassed: true,
      enabled: true,
    });
    expect(out.admitted).toBe(true);
    expect(out.verdict).toBe('success');
    expect(out.summary).toBe('The price is $24.99');
  });

  it('on path fails closed: ungrounded success downgrades to partial + note', () => {
    const out = resolveFinishGate({
      verdict: 'success',
      summary: 'The price is $999.99',
      observed,
      postPassed: true,
      enabled: true,
    });
    expect(out.admitted).toBe(false);
    expect(out.verdict).toBe('partial');
    expect(out.summary).toContain('The price is $999.99');
    expect(out.summary).toMatch(/unverified/i);
  });

  it('on path fails closed on post-state fail + empty summary', () => {
    const failed = resolveFinishGate({
      verdict: 'success',
      summary: 'The price is $24.99',
      observed,
      postPassed: false,
      enabled: true,
    });
    expect(failed.admitted).toBe(false);
    const empty = resolveFinishGate({
      verdict: 'success',
      summary: '   ',
      observed,
      postPassed: true,
      enabled: true,
    });
    expect(empty.admitted).toBe(false);
  });
});

describe('T20 debt: T18 Q + T19 UD gap recorded as scheduler debt (BRAIN TDD)', () => {
  // NOTE (T20 Qs, seam-only legacy): off-path tail-slice is seam-only legacy —
  // production compact is LLM runHelperCompaction; scheduler wiring decides
  // replace vs wrap. On-path strictness (numbers+entities) is intentional vs
  // numbers-only — keep.
  it('is static BRAIN-only: no provider/fetch/LLM import in the gate path', () => {
    const text = readFileSync(join(process.cwd(), 'src/agent/verify/grounding.ts'), 'utf8');
    expect(text).not.toMatch(/^\s*import\s.*(provider|fetch|facts|llm)/mi);
    expect(text).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket)\b/);
  });
});
