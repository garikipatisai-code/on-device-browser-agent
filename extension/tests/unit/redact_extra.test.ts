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

  it('falls back to a fixed [redacted] string if args cannot round-trip through JSON (never throws)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const ev: TimelineEvent = { kind: 'tool.call', ts: 0, tool: 'weird', args: circular };
    expect(() => redactEvent(ev)).not.toThrow();
    const out = redactEvent(ev) as Extract<TimelineEvent, { kind: 'tool.call' }>;
    expect(out.args).toBe('[redacted]');
  });
});
