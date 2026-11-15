// T3: think-routing + GBNF + 1 retry (BRAIN TDD).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { routeThink, EXECUTOR_RETRY_MAX, shouldRetryExecutor } from '@/agent/orchestrator';
import { TOOL_CALL_GBNF_SCHEMA } from '@/shared/messages';

describe('routeThink — NO_THINK single-tool vs THINK multi-turn/every-3rd', () => {
  it('routes a single-tool task to NO_THINK', () => {
    expect(routeThink({ stepCount: 1, turn: 1 })).toBe('NO_THINK');
  });

  it('routes a multi-turn task to THINK', () => {
    expect(routeThink({ stepCount: 3, turn: 1 })).toBe('THINK');
  });

  it('routes every-3rd turn to THINK even for single-tool tasks', () => {
    expect(routeThink({ stepCount: 1, turn: 3 })).toBe('THINK');
    expect(routeThink({ stepCount: 1, turn: 6 })).toBe('THINK');
  });

  it('keeps non-3rd single-tool turns on NO_THINK', () => {
    expect(routeThink({ stepCount: 1, turn: 2 })).toBe('NO_THINK');
    expect(routeThink({ stepCount: 1, turn: 4 })).toBe('NO_THINK');
  });
});

describe('GBNF tool-call schema', () => {
  it('forbids additional properties (grammar-constrained decoding)', () => {
    expect((TOOL_CALL_GBNF_SCHEMA as Record<string, unknown>).additionalProperties).toBe(false);
  });

  it('constrains to {tool, args} with tool required', () => {
    const schema = TOOL_CALL_GBNF_SCHEMA as Record<string, any>;
    expect(schema.type).toBe('object');
    expect(schema.properties.tool).toBeDefined();
    expect(schema.properties.args).toBeDefined();
    expect(schema.required).toContain('tool');
  });
});

describe('executor retry bound <= 1', () => {
  it('caps retries at one', () => {
    expect(EXECUTOR_RETRY_MAX).toBeLessThanOrEqual(1);
  });

  it('allows the first retry but not a second', () => {
    expect(shouldRetryExecutor(0)).toBe(true);
    expect(shouldRetryExecutor(1)).toBe(false);
    expect(shouldRetryExecutor(2)).toBe(false);
  });
});

describe('verify retry gate check-before-increment (T3 High)', () => {
  it('checks shouldRetryExecutor before incrementing verifyAttempts', () => {
    const text = readFileSync(join(process.cwd(), 'src/agent/orchestrator.ts'), 'utf8');
    const checkIdx = text.indexOf('if (!shouldRetryExecutor(this.verifyAttempts))');
    expect(checkIdx).toBeGreaterThan(-1);
    const incrIdx = text.indexOf('this.verifyAttempts += 1');
    expect(incrIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeLessThan(incrIdx);
  });

  it('first rejection retries, second returns (check-before-increment semantics)', () => {
    let verifyAttempts = 0;
    const gate = (): 'retry' | 'partial' => {
      if (!shouldRetryExecutor(verifyAttempts)) return 'partial';
      verifyAttempts += 1;
      return 'retry';
    };
    expect(gate()).toBe('retry');
    expect(gate()).toBe('partial');
  });
});

describe('prose answer bound (T3 Med)', () => {
  it('gates mid-plan prose rejections through the same retry bound', () => {
    const text = readFileSync(join(process.cwd(), 'src/agent/orchestrator.ts'), 'utf8');
    const proseIdx = text.indexOf("execOut.tool === 'answer'");
    expect(proseIdx).toBeGreaterThan(-1);
    const after = text.slice(proseIdx, proseIdx + 2000);
    expect(after).toContain('shouldRetryExecutor');
  });
});

describe('structured format seam (T3 Low)', () => {
  it('has no dead void structuredToolCallFormat call', () => {
    const text = readFileSync(join(process.cwd(), 'src/agent/orchestrator.ts'), 'utf8');
    expect(text).not.toContain('void structuredToolCallFormat');
  });
});
