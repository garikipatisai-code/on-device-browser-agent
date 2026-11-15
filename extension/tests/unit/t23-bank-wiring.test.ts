// T23 bank wiring bound 2 (BRAIN TDD, 0 LLM calls).
// Pins the evaluator FAIL order lookupRecovery → tryBacktrack → replan,
// a dedicated bank-attempt bound of exactly 2, and dirty-flag set.
// Documents the T22 open Qs (empty-steps warn, retry idempotence) as
// scheduler-owned debt (deferred, NOT fixed here).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lookupRecovery, RECOVERY_BANK_MAX_ATTEMPTS } from '@/agent/workflow_memory';
import { Orchestrator } from '@/agent/orchestrator';
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

describe('T23 FAIL-path hook order — lookupRecovery → tryBacktrack → replan', () => {
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

describe('T23 bank-attempt bound — exactly 2, no maxTurns-only retry', () => {
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

describe('T23 dirty flag — bank recovery poisons clean-recipe path', () => {
  it('marks the run dirty on a bank recovery', () => {
    const orch = makeOrch() as unknown as BankPriv;
    (orch as unknown as { tryBacktrackBank: (r: string) => boolean }).tryBacktrackBank(
      'aria.extract returned empty content on the page',
    );
    expect(orch.runDirty).toBe(true);
  });
});

describe('T22 open Qs recorded as scheduler debt (T23)', () => {
  it('documents empty-steps warn + retry idempotence as deferred scheduler debt', () => {
    const orchText = readFileSync(join(process.cwd(), 'src/agent/orchestrator.ts'), 'utf8');
    expect(orchText).toContain('T23 DEBT');
    expect(orchText).toMatch(/empty-steps/i);
    expect(orchText).toMatch(/retry idempotence/i);
    expect(orchText).toMatch(/scheduler/i);
  });
});
