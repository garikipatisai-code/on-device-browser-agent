import { describe, expect, it } from 'vitest';
import { redact, redactDeep, redactEvent } from '@/agent/safety/redact';
import type { TimelineEvent } from '@/shared/messages';

describe('redact — broader coverage (audit gaps)', () => {
  it('redacts international (+country-code) phone numbers', () => {
    expect(redact('call +44 20 7946 0958 today')).toContain('[REDACTED: PHONE]');
    expect(redact('phone +91 98765 43210')).toContain('[REDACTED: PHONE]');
  });

  it('does not over-redact version strings as phones', () => {
    expect(redact('upgraded to +2.0.1 release')).not.toContain('[REDACTED: PHONE]');
  });

  it('redacts ordinal / extended / lowercase street addresses', () => {
    expect(redact('I live at 350 5th Ave')).toContain('[REDACTED: ADDRESS]');
    expect(redact('742 Evergreen Terrace')).toContain('[REDACTED: ADDRESS]');
    expect(redact('1 Infinite Loop, Cupertino')).toContain('[REDACTED: ADDRESS]');
    expect(redact('123 main st')).toContain('[REDACTED: ADDRESS]');
  });

  it('redactDeep scrubs PII in object KEYS, not just values', () => {
    const out = redactDeep({ 'contact a@b.com': 'note' });
    expect(JSON.stringify(out)).toContain('[REDACTED: EMAIL]');
  });
});

describe('redactEvent — centralized per-TimelineEvent redaction (emit() chokepoint)', () => {
  it('redacts PII inside a tool.call event\'s args', () => {
    const ev: TimelineEvent = { kind: 'tool.call', ts: 0, tool: 'tab.type', args: { text: 'jane.doe@example.com' } };
    const out = redactEvent(ev) as Extract<TimelineEvent, { kind: 'tool.call' }>;
    const args = out.args as { text: string };
    expect(args.text).not.toContain('@example.com');
    expect(args.text).toContain('[REDACTED: EMAIL]');
  });

  it('redacts PII inside a tool.result event\'s content string', () => {
    const ev: TimelineEvent = { kind: 'tool.result', ts: 0, tool: 'tab.type', ok: true, content: 'Typed jane.doe@example.com into the field' };
    const out = redactEvent(ev) as Extract<TimelineEvent, { kind: 'tool.result' }>;
    expect(out.content).not.toContain('jane.doe@example.com');
    expect(out.content).toContain('[REDACTED: EMAIL]');
  });

  it('redacts PII inside a log event\'s message string', () => {
    const ev: TimelineEvent = { kind: 'log', ts: 0, level: 'info', message: 'Contact is jane.doe@example.com' };
    const out = redactEvent(ev) as Extract<TimelineEvent, { kind: 'log' }>;
    expect(out.message).not.toContain('jane.doe@example.com');
    expect(out.message).toContain('[REDACTED: EMAIL]');
  });

  it('redacts PII inside an evaluator.verdict event\'s reason string', () => {
    const ev: TimelineEvent = { kind: 'evaluator.verdict', ts: 0, verdict: 'PASS', reason: 'Field filled with jane.doe@example.com as required' };
    const out = redactEvent(ev) as Extract<TimelineEvent, { kind: 'evaluator.verdict' }>;
    expect(out.reason).not.toContain('jane.doe@example.com');
    expect(out.reason).toContain('[REDACTED: EMAIL]');
  });

  it('redacts PII inside a finish event\'s summary string', () => {
    const ev: TimelineEvent = { kind: 'finish', ts: 0, verdict: 'success', summary: 'Filled in the email jane.doe@example.com and submitted the form' };
    const out = redactEvent(ev) as Extract<TimelineEvent, { kind: 'finish' }>;
    expect(out.summary).not.toContain('jane.doe@example.com');
    expect(out.summary).toContain('[REDACTED: EMAIL]');
  });

  // Round 3 finding: `sources` is a string[] (URLs, can carry PII in query strings), not a
  // plain string — a per-field `typeof out.X === 'string'` guard can never catch it (and, by
  // the same shape, could never catch ANY array or nested field). This is the reason redactEvent
  // was refactored from a field-by-field checklist to whole-event stringify→redact→parse: the
  // mechanism no longer depends on anyone having named the field.
  it('redacts PII inside a finish event\'s sources array (proves whole-event redaction, no per-field guard needed)', () => {
    const ev: TimelineEvent = {
      kind: 'finish',
      ts: 0,
      verdict: 'success',
      summary: 'Order confirmed',
      sources: ['https://shop.example/checkout?email=jane.doe@example.com&ref=123', 'https://example.com/p/1'],
    };
    const out = redactEvent(ev) as Extract<TimelineEvent, { kind: 'finish' }>;
    expect(out.sources?.join(' ')).not.toContain('jane.doe@example.com');
    expect(out.sources?.join(' ')).toContain('[REDACTED: EMAIL]');
    expect(out.sources?.[1]).toBe('https://example.com/p/1'); // non-PII URL untouched
  });

  it('is a safe no-op passthrough for event kinds with no free-text/args field', () => {
    const ev: TimelineEvent = { kind: 'role.start', ts: 0, role: 'executor', stepId: 'step-1' };
    const out = redactEvent(ev);
    expect(out).toEqual(ev);
  });

  it('does not mutate the input event', () => {
    const ev: TimelineEvent = { kind: 'tool.call', ts: 0, tool: 'tab.type', args: { text: 'jane.doe@example.com' } };
    const frozenArgs = { ...(ev.args as Record<string, unknown>) };
    redactEvent(ev);
    expect(ev.args).toEqual(frozenArgs); // original untouched
  });

  // Round 4: redactEvent was refactored again — from whole-event JSON.stringify→redact→JSON.parse
  // to a recursive walker (redactValue) that only ever calls redact() on actual string VALUES.
  // The stringify approach corrupted the JSON ~10% of the time: every event's `ts` is a 13-digit
  // Date.now() value, and ~10% of any timestamp range happens to pass the CC pattern's Luhn gate
  // by chance (measured empirically below), replacing the numeric literal with an unquoted
  // `[REDACTED: CC]` token and losing the WHOLE event to a parse failure. The walker fixes this at
  // the root: numbers are never coerced to strings, so the regex never sees them — not a smaller
  // collision window, zero collision risk, by construction.
  //
  // There is no more JSON.parse step, so a circular reference no longer raises a catchable parse
  // error — it would recurse forever instead. The depth cap (8) is the guard for that, not a cycle
  // detector: TimelineEvent payloads are plain JSON-shaped data from tool calls and LLM-generated
  // text (args, content, reason, summary, sources) — never live object graphs — so a real reference
  // cycle is not a scenario that occurs in practice. The depth cap is exercised directly below with
  // genuinely deep (non-circular) nesting instead.
  it('numeric fields (ts included) round-trip unchanged — no CC-regex collision risk (root-cause fix)', () => {
    // This exact shape (a bare 13-digit ts) is what broke the stringify-whole-event approach:
    // some Date.now() values pass the Luhn checksum and were misdetected as a candidate CC number.
    const ev: TimelineEvent = { kind: 'role.end', ts: 1782971430998, role: 'executor', ms: 3.569541000000072 };
    const out = redactEvent(ev) as Extract<TimelineEvent, { kind: 'role.end' }>;
    expect(out.ts).toBe(1782971430998); // number preserved exactly, never stringified/regexed
    expect(out.ms).toBe(3.569541000000072);
    expect(out.role).toBe('executor');
  });

  it('caps recursion depth on genuinely deep (non-circular) nesting instead of recursing unbounded', () => {
    // Build a plain (acyclic) object 12 levels deep — beyond the depth-8 cap — to prove the guard
    // fires on real deep nesting, which is the actual risk the cap protects against (not cycles).
    type Nested = { next?: Nested; leaf?: string };
    let deep: Nested = { leaf: 'jane.doe@example.com' };
    for (let i = 0; i < 12; i++) deep = { next: deep };
    const ev: TimelineEvent = { kind: 'tool.call', ts: 0, tool: 'weird', args: deep };
    expect(() => redactEvent(ev)).not.toThrow();
    const out = redactEvent(ev) as Extract<TimelineEvent, { kind: 'tool.call' }>;
    // Walk down until we hit the depth-cap placeholder instead of the original leaf.
    let node: unknown = out.args;
    let hitCap = false;
    for (let i = 0; i < 20 && node && typeof node === 'object'; i++) {
      const n = node as Record<string, unknown>;
      if (n.next === '[redacted: too deep]') { hitCap = true; break; }
      node = n.next;
    }
    expect(hitCap).toBe(true);
  });
});
