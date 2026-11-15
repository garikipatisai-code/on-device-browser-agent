// T28 bank wiring into executeOne (BRAIN TDD, 0 LLM calls).
// Pins the evaluator FAIL order lookupRecovery → tryBacktrack → replan,
// a dedicated bank-attempt bound of exactly 2, and dirty-flag set —
// threaded at source level against the single-step executeOne dispatch
// path (periodic FAIL && shouldReplan only, T18 pattern). Documents the
// T27 open debt (single-step dispatch, multi-step fan-out deferred) and
// the step-advance FAIL path (no bank hook) as scheduler-owned debt.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lookupRecovery, RECOVERY_BANK_MAX_ATTEMPTS } from '@/agent/workflow_memory';
import { Orchestrator, shouldTryBankRecovery } from '@/agent/orchestrator';
import { ToolRegistry } from '@/agent/tools/registry';
import { DEFAULT_SETTINGS } from '@/shared/messages';
import { makeFakeOllama } from '../helpers';

function makeOrch(): Orchestrator {
  return new Orchestrator({
    ollama: makeFakeOllama({}),
    registry: new ToolRegistry(),
    settings: { ...DEFAULT_SETTINGS },
    emit: () => undefined,
  });
}

type BankPriv = {
  tryBacktrackBank: (r: string) => boolean;
  runDirty: boolean;
  bankAttemptsUsed: number;
};

describe('T28 FAIL-path hook order — lookupRecovery → tryBacktrack → replan', () => {
  const text = readFileSync(join(process.cwd(), 'src/agent/orchestrator.ts'), 'utf8');

  it('hooks the bank before backtrack before replan on evaluator FAIL', () => {
    const failIdx = text.indexOf("ev.verdict === 'FAIL'");
    expect(failIdx).toBeGreaterThan(-1);
    const tail = text.slice(failIdx, failIdx + 1200);
    const bankPos = tail.indexOf('tryBacktrackBank');
    const backtrackPos = tail.indexOf('tryBacktrack()');
    const replanPos = tail.indexOf('this.replan(');
    expect(bankPos).toBeGreaterThan(-1);
    expect(backtrackPos).toBeGreaterThan(-1);
    expect(replanPos).toBeGreaterThan(-1);
    expect(bankPos).toBeLessThan(backtrackPos);
    expect(backtrackPos).toBeLessThan(replanPos);
  });

  it('bank method wires lookupRecovery (order root) + dirty flag', () => {
    const methodIdx = text.indexOf('private tryBacktrackBank(');
    expect(methodIdx).toBeGreaterThan(-1);
    const tail = text.slice(methodIdx, methodIdx + 900);
    expect(tail).toContain('lookupRecovery');
    expect(tail).toContain('markDirty');
  });
});

describe('T28 bank-attempt bound — exactly 2, no maxTurns-only retry', () => {
  it('pins the dedicated bound to exactly 2', () => {
    expect(RECOVERY_BANK_MAX_ATTEMPTS).toBe(2);
  });

  it('bounds bank attempts: true within budget, false once exhausted', () => {
    const orch = makeOrch() as unknown as BankPriv;
    const reason = 'search returned no results for the query — try again';
    expect(lookupRecovery(reason)).not.toBeNull();
    for (let i = 0; i < RECOVERY_BANK_MAX_ATTEMPTS; i += 1) {
      expect(orch.tryBacktrackBank(reason)).toBe(true);
    }
    expect(orch.bankAttemptsUsed).toBe(RECOVERY_BANK_MAX_ATTEMPTS);
    expect(orch.tryBacktrackBank(reason)).toBe(false);
    expect(orch.tryBacktrackBank(reason)).toBe(false);
  });

  it('falls back (false) for unknown signatures without spending budget', () => {
    const orch = makeOrch() as unknown as BankPriv;
    expect(orch.tryBacktrackBank('qubit flux destabilized the warp core')).toBe(false);
    expect(orch.bankAttemptsUsed).toBe(0);
  });

  it('is not bounded only by maxTurns — dedicated budget check in source', () => {
    const text = readFileSync(join(process.cwd(), 'src/agent/orchestrator.ts'), 'utf8');
    const methodIdx = text.indexOf('private tryBacktrackBank(');
    expect(methodIdx).toBeGreaterThan(-1);
    const tail = text.slice(methodIdx, methodIdx + 900);
    expect(tail).toMatch(/bankAttemptsUsed|RECOVERY_BANK_MAX_ATTEMPTS/);
  });
});

describe('T28 dirty flag — bank recovery poisons clean-recipe path', () => {
  it('marks the run dirty on a bank recovery', () => {
    const orch = makeOrch() as unknown as BankPriv;
    (orch as unknown as { tryBacktrackBank: (r: string) => boolean }).tryBacktrackBank(
      'aria.extract returned empty content on the page',
    );
    expect(orch.runDirty).toBe(true);
  });
});

describe('T28 FAIL && shouldReplan gate seam — periodic only (T18 pattern)', () => {
  it('fires only on FAIL with shouldReplan', () => {
    expect(shouldTryBankRecovery({ verdict: 'FAIL', shouldReplan: true })).toBe(true);
    expect(shouldTryBankRecovery({ verdict: 'FAIL', shouldReplan: false })).toBe(false);
    expect(shouldTryBankRecovery({ verdict: 'PASS', shouldReplan: true })).toBe(false);
    expect(shouldTryBankRecovery({ verdict: 'PASS', shouldReplan: false })).toBe(false);
  });

  it('missing shouldReplan counts as off (fail-closed)', () => {
    expect(shouldTryBankRecovery({ verdict: 'FAIL' })).toBe(false);
  });

  it('the periodic FAIL branch routes through the gate seam', () => {
    const text = readFileSync(join(process.cwd(), 'src/agent/orchestrator.ts'), 'utf8');
    const failIdx = text.indexOf("ev.verdict === 'FAIL'");
    expect(failIdx).toBeGreaterThan(-1);
    const tail = text.slice(failIdx, failIdx + 1200);
    expect(tail).toContain('shouldTryBankRecovery');
    expect(tail).toContain('tryBacktrackBank');
  });
});

describe('T28 debt — step-advance uncovered + T27 single-step/fan-out carried', () => {
  it('documents periodic-only bank + step-advance + T27 debt as scheduler-owned', () => {
    const orchText = readFileSync(join(process.cwd(), 'src/agent/orchestrator.ts'), 'utf8');
    expect(orchText).toContain('T28 DEBT');
    expect(orchText).toMatch(/periodic/);
    expect(orchText).toMatch(/step-advance/);
    expect(orchText).toMatch(/T27/);
    expect(orchText).toMatch(/single-step/);
    expect(orchText).toMatch(/fan-out/);
    expect(orchText).toMatch(/scheduler/i);
  });
});
