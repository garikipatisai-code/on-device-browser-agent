import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { DomainTier } from '@/shared/messages';
import { actionHash, parseJSONPermissive, stableStringify, TokenRatioEstimator } from '@/agent/util';
import { newPlan, walkPlan } from '@/agent/plan';
import { getDomainTier, TIER_ORDER } from '@/agent/safety/domain_tiers';

describe('property: actionHash', () => {
  it('is key-order invariant', () => {
    fc.assert(
      fc.property(fc.string(), fc.dictionary(fc.string(), fc.jsonValue()), (name, args) => {
        const a = actionHash(name, args);
        const reordered: Record<string, unknown> = {};
        for (const k of Object.keys(args).reverse()) reordered[k] = args[k];
        const b = actionHash(name, reordered);
        return a === b;
      }),
      { numRuns: 200 },
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(fc.string(), fc.dictionary(fc.string(), fc.jsonValue()), (n, args) => {
        return actionHash(n, args) === actionHash(n, args);
      }),
      { numRuns: 200 },
    );
  });

  it('distinguishes tool names', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => s.length > 0),
        fc.string({ minLength: 1 }).filter((s) => s.length > 0),
        fc.dictionary(fc.string(), fc.jsonValue()),
        (a, b, args) => {
          if (a === b) return true;
          return actionHash(a, args) !== actionHash(b, args);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('property: parseJSONPermissive', () => {
  it('never throws on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 5_000 }), (s) => {
        expect(() => parseJSONPermissive(s)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });

  it('round-trips valid JSON', () => {
    // JSON.stringify(-0) produces "0", so JSON.parse("0") returns +0 — this is a
    // JSON-spec lossiness, not a parseJSONPermissive bug.  Filter out any value tree
    // that contains -0 so the property only asserts the function's real contract:
    // "for any value that JSON can represent losslessly, round-tripping via
    //  JSON.stringify → parseJSONPermissive returns the original value."
    function hasNegativeZero(v: unknown): boolean {
      if (Object.is(v, -0)) return true;
      if (Array.isArray(v)) return v.some(hasNegativeZero);
      if (v !== null && typeof v === 'object')
        return Object.values(v as Record<string, unknown>).some(hasNegativeZero);
      return false;
    }
    fc.assert(
      fc.property(fc.jsonValue().filter((v) => !hasNegativeZero(v)), (v) => {
        const s = JSON.stringify(v);
        expect(parseJSONPermissive(s)).toEqual(v);
      }),
      { numRuns: 200 },
    );
  });

  it('strips wrapping prose', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const s = JSON.stringify(v);
        if (s === 'null' || s === 'true' || s === 'false' || /^-?\d/.test(s) || s.startsWith('"')) {
          return true;
        }
        const wrapped = `Sure! Here you go: ${s} (let me know).`;
        return JSON.stringify(parseJSONPermissive(wrapped)) === s;
      }),
      { numRuns: 200 },
    );
  });
});

describe('property: stableStringify', () => {
  it('is invariant under key permutation', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), fc.jsonValue()), (obj) => {
        const a = stableStringify(obj);
        const reordered: Record<string, unknown> = {};
        for (const k of Object.keys(obj).sort().reverse()) reordered[k] = obj[k];
        return stableStringify(reordered) === a;
      }),
      { numRuns: 200 },
    );
  });
});

describe('property: walkPlan immutability', () => {
  it('does not mutate input plan', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 6 }), (descs) => {
        const plan = newPlan(descs.map((d) => ({ description: d, successCriteria: d })));
        const copy = JSON.parse(JSON.stringify(plan));
        walkPlan(plan, plan.steps[0].id, 'done');
        return JSON.stringify(plan) === JSON.stringify(copy);
      }),
      { numRuns: 100 },
    );
  });
});

describe('property: TokenRatioEstimator stays positive', () => {
  it('never produces zero/negative tokens for non-empty text', () => {
    const est = new TokenRatioEstimator();
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (s) => {
        return est.approxTokens(s) >= 1;
      }),
      { numRuns: 100 },
    );
  });
});

describe('property: domain tier ordering', () => {
  it('TIER_ORDER is transitive', () => {
    expect(TIER_ORDER['read-only'] < TIER_ORDER['click-only']).toBe(true);
  });

  it('unknown hosts default to read-only for arbitrary configs', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.constantFrom('read-only' as const, 'click-only' as const)), (tiers) => {
        return getDomainTier('totally-unconfigured-host-name-xyz.example', tiers) === 'read-only';
      }),
      { numRuns: 100 },
    );
  });

  it('a legacy "full-action" value anywhere in the config never changes the unknown-host default', () => {
    // Regression guard for the tier-collapse migration: getDomainTier must keep defaulting
    // unconfigured hosts to read-only no matter what legacy values other hosts carry.
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string({ minLength: 1, maxLength: 20 }),
          fc.constantFrom('read-only' as const, 'click-only' as const, 'full-action' as const),
        ),
        (tiers) => {
          const legacy = tiers as unknown as Record<string, DomainTier>;
          return getDomainTier('totally-unconfigured-host-name-xyz.example', legacy) === 'read-only';
        },
      ),
      { numRuns: 100 },
    );
  });
});
