import { describe, expect, it } from 'vitest';
import {
  actionHash,
  parseJSONPermissive,
  stableStringify,
  TokenRatioEstimator,
  ulid,
} from '@/agent/util';

describe('stableStringify', () => {
  it('produces same string regardless of key order', () => {
    const a = { x: 1, y: { b: 2, a: 1 }, z: [1, 2] };
    const b = { z: [1, 2], y: { a: 1, b: 2 }, x: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });
  it('handles primitives', () => {
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(42)).toBe('42');
    expect(stableStringify('s')).toBe('"s"');
  });
});

describe('actionHash', () => {
  it('is deterministic', () => {
    const h1 = actionHash('tab.click', { tabId: 5, elementIndex: 3 });
    const h2 = actionHash('tab.click', { tabId: 5, elementIndex: 3 });
    expect(h1).toBe(h2);
  });
  it('discriminates tool names', () => {
    const a = actionHash('tab.click', { tabId: 5 });
    const b = actionHash('tab.type', { tabId: 5 });
    expect(a).not.toBe(b);
  });
  it('discriminates args', () => {
    const a = actionHash('tab.click', { tabId: 5, elementIndex: 1 });
    const b = actionHash('tab.click', { tabId: 5, elementIndex: 2 });
    expect(a).not.toBe(b);
  });
  it('is key-order invariant', () => {
    expect(actionHash('x', { a: 1, b: 2 })).toBe(actionHash('x', { b: 2, a: 1 }));
  });
});

describe('parseJSONPermissive', () => {
  it('parses plain JSON', () => {
    expect(parseJSONPermissive('{"x":1}')).toEqual({ x: 1 });
  });
  it('strips fenced code block', () => {
    expect(parseJSONPermissive('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });
  it('extracts first balanced object', () => {
    expect(parseJSONPermissive('the answer is {"k":"v"} ok')).toEqual({ k: 'v' });
  });
  it('handles arrays', () => {
    expect(parseJSONPermissive('[1,2,3]')).toEqual([1, 2, 3]);
  });
  it('returns null on garbage', () => {
    expect(parseJSONPermissive('hello world')).toBeNull();
    expect(parseJSONPermissive('')).toBeNull();
  });
  it('handles nested objects', () => {
    expect(parseJSONPermissive('prefix {"a":{"b":[1,{"c":2}]}} suffix')).toEqual({
      a: { b: [1, { c: 2 }] },
    });
  });
  it('handles escaped quotes inside strings', () => {
    expect(parseJSONPermissive('text: {"msg":"she said \\"hi\\""} done')).toEqual({
      msg: 'she said "hi"',
    });
  });
});

describe('TokenRatioEstimator', () => {
  it('seeds at 4.0', () => {
    const e = new TokenRatioEstimator();
    expect(e.currentRatio()).toBeCloseTo(4.0);
    expect(e.approxTokens('1234')).toBe(1);
    expect(e.approxTokens('12345')).toBe(2);
  });
  it('updates by EWMA', () => {
    const e = new TokenRatioEstimator(0.5);
    e.observe(800, 200);
    expect(e.currentRatio()).toBeCloseTo(4);
    e.observe(800, 400);
    expect(e.currentRatio()).toBeCloseTo(3);
  });
  it('resets to seed', () => {
    const e = new TokenRatioEstimator(0.5);
    e.observe(100, 1000);
    e.reset();
    expect(e.currentRatio()).toBeCloseTo(4.0);
  });
});

describe('ulid', () => {
  it('produces unique IDs', () => {
    const ids = new Set();
    for (let i = 0; i < 200; i++) ids.add(ulid());
    expect(ids.size).toBe(200);
  });
});
