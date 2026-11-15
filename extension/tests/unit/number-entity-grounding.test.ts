import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertNumbersEntitiesGrounded,
  getPostState,
  isFinishAdmissible,
} from '@/agent/verify/grounding';

// T2: number+entity grounding gate + re-ground (BRAIN-only, 0 LLM calls).
describe('number+entity grounding gate (T2)', () => {
  it('triggers RE_GROUND on a novel number', () => {
    const r = assertNumbersEntitiesGrounded(
      'The price is $999.99',
      'the page shows $24.99 in stock',
    );
    expect(r.decision).toBe('RE_GROUND');
  });

  it('triggers RE_GROUND on a novel Capitalized noun', () => {
    const r = assertNumbersEntitiesGrounded(
      'Per the Smithsonian Report it is the best pick',
      'the page shows $24.99 in stock, Logitech mouse',
    );
    expect(r.decision).toBe('RE_GROUND');
  });

  it('returns OK when numbers/entities are grounded (whitespace-insensitive, 0.5≡50%)', () => {
    expect(
      assertNumbersEntitiesGrounded('The price is $24.99', 'the page shows $24.99 in stock')
        .decision,
    ).toBe('OK');
    // 0.5 ≡ 50% equivalence note
    expect(
      assertNumbersEntitiesGrounded('success rate 0.5 overall', 'success rate 50% observed')
        .decision,
    ).toBe('OK');
    // whitespace-insensitive entity match
    expect(
      assertNumbersEntitiesGrounded(
        'Logitech M185 is the pick',
        'the page shows   logitech    m185 wireless mouse',
      ).decision,
    ).toBe('OK');
  });

  it('is static BRAIN-only: grounding module has no provider/fetch/LLM import', () => {
    const text = readFileSync(join(process.cwd(), 'src/agent/verify/grounding.ts'), 'utf8');
    expect(text).not.toMatch(/^\s*import\s.*(provider|fetch|facts|llm)/mi);
    // Dynamic exfil/LLM paths must also stay out: dynamic import(), require(),
    // and any fetch/XHR/WebSocket use.
    expect(text).not.toMatch(/\bimport\s*\(/m);
    expect(text).not.toMatch(/\brequire\s*\(/m);
    expect(text).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket)\b/);
  });

  it('returns RE_GROUND on empty/whitespace-only summary (fail-closed, not vacuous OK)', () => {
    expect(assertNumbersEntitiesGrounded('', 'the page shows $24.99').decision).toBe(
      'RE_GROUND',
    );
    expect(assertNumbersEntitiesGrounded('   ', 'the page shows $24.99').decision).toBe(
      'RE_GROUND',
    );
  });

  it('dedupes repeated ungrounded numbers', () => {
    const r = assertNumbersEntitiesGrounded(
      'The price is $999.99, yes $999.99',
      'the page shows $24.99 in stock',
    );
    expect(r.decision).toBe('RE_GROUND');
    expect(r.ungrounded.filter((t) => t === '$999.99')).toHaveLength(1);
  });

  it('ignores bare single digits (list markers are not data)', () => {
    expect(
      assertNumbersEntitiesGrounded('top 3 picks', 'unrelated page text here').decision,
    ).toBe('OK');
  });

  it('wires the finish gate to T2: blocked/failed still ground, entities fail-closed', () => {
    const post = getPostState({ passed: true });
    // blocked/failed ground regardless of verdict — no skip.
    expect(
      isFinishAdmissible(
        { verdict: 'blocked', summary: 'The price is $999.99' },
        'the page shows $24.99 in stock',
        post,
      ).decision,
    ).toBe('FAIL_CLOSED');
    expect(
      isFinishAdmissible(
        { verdict: 'failed', summary: 'The price is $999.99' },
        'the page shows $24.99 in stock',
        post,
      ).decision,
    ).toBe('FAIL_CLOSED');
    // entity grounding delegates to T2: a novel Capitalized entity fails the gate.
    expect(
      isFinishAdmissible(
        { verdict: 'success', summary: 'Per the Smithsonian Report it is the best pick' },
        'the page shows $24.99 in stock, Logitech mouse',
        post,
      ).decision,
    ).toBe('FAIL_CLOSED');
  });
});
