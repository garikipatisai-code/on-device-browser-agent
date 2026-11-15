import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getPostState, isFinishAdmissible } from '@/agent/verify/grounding';

// BRAIN-only gate: deterministic, 0 LLM calls. The mock counter below is never
// passed to the gate — it exists only to assert no LLM path was touched.
describe('finish gate fail-closed (T1)', () => {
  it('is inadmissible on missing args', () => {
    const post = getPostState({ passed: true });
    expect(isFinishAdmissible(null, 'page shows $24.99', post).ok).toBe(false);
    expect(isFinishAdmissible(undefined, 'page shows $24.99', post).decision).toBe('FAIL_CLOSED');
    expect(isFinishAdmissible({}, 'page shows $24.99', post).ok).toBe(false);
    expect(
      isFinishAdmissible({ verdict: 'success' }, 'page shows $24.99', post).decision,
    ).toBe('FAIL_CLOSED');
    expect(
      isFinishAdmissible({ verdict: 'success', summary: '   ' }, 'page shows $24.99', post).ok,
    ).toBe(false);
  });

  it('is inadmissible on ungrounded numbers', () => {
    const post = getPostState({ passed: true });
    const r = isFinishAdmissible(
      { verdict: 'success', summary: 'The price is $999.99' },
      'the page shows $24.99 in stock',
      post,
    );
    expect(r.ok).toBe(false);
    expect(r.decision).toBe('FAIL_CLOSED');
  });

  it('is inadmissible on post-state fail/missing', () => {
    const observed = 'the page shows $24.99 in stock';
    const args = { verdict: 'success', summary: 'The price is $24.99' };
    expect(isFinishAdmissible(args, observed, getPostState({ passed: false })).ok).toBe(false);
    expect(isFinishAdmissible(args, observed, getPostState(null)).decision).toBe('FAIL_CLOSED');
    expect(isFinishAdmissible(args, observed, null).ok).toBe(false);
    expect(isFinishAdmissible(args, observed, undefined).decision).toBe('FAIL_CLOSED');
  });

  it('is admissible (OK) only when grounded + post-state passed', () => {
    const r = isFinishAdmissible(
      { verdict: 'success', summary: 'The price is $24.99' },
      'the page shows $24.99 in stock',
      getPostState({ passed: true }),
    );
    expect(r.ok).toBe(true);
    expect(r.decision).toBe('OK');
  });

  it('getPostState normalizes fail-closed', () => {
    expect(getPostState(null).passed).toBe(false);
    expect(getPostState(undefined).passed).toBe(false);
    expect(getPostState({ passed: false }).passed).toBe(false);
    expect(getPostState({ passed: true }).passed).toBe(true);
  });

  it('is static BRAIN-only: grounding module has no provider/fetch/facts import', () => {
    const text = readFileSync(join(process.cwd(), 'src/agent/verify/grounding.ts'), 'utf8');
    expect(text).not.toMatch(/^\s*import\s.*(provider|fetch|facts)/mi);
  });
});
