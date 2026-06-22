import { describe, expect, it } from 'vitest';
import { clampNumCtx, budgetsFor, capsFor, DEFAULT_NUM_CTX } from '@/agent/budget';

describe('clampNumCtx', () => {
  it('defaults when unset/invalid', () => {
    expect(clampNumCtx(undefined)).toBe(DEFAULT_NUM_CTX);
    expect(clampNumCtx(Number.NaN)).toBe(DEFAULT_NUM_CTX);
  });
  it('clamps to [8192, 131072]', () => {
    expect(clampNumCtx(1000)).toBe(8_192);
    expect(clampNumCtx(999_999)).toBe(131_072);
    expect(clampNumCtx(65_536)).toBe(65_536);
  });
});
describe('budgetsFor / capsFor scale with the window', () => {
  it('baseline at 32K, ~4x at 128K', () => {
    expect(budgetsFor(DEFAULT_NUM_CTX).executor).toBe(26_000);
    expect(budgetsFor(131_072).executor).toBe(104_000);
    expect(capsFor(DEFAULT_NUM_CTX).observed).toBe(60_000);
    expect(capsFor(131_072).page).toBe(48_000);
  });
});
