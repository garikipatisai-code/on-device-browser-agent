import { describe, expect, it } from 'vitest';
import { buildProfileExtractionMessages, normalizeExtractedProfile, parseProfile, renderProfileBlock } from '@/agent/profile';

describe('parseProfile', () => {
  it('parses a JSON object', () => {
    expect(parseProfile('{"name":"Jane","email":"j@x.com"}')).toEqual({ name: 'Jane', email: 'j@x.com' });
  });
  it('returns null for empty / invalid / non-object JSON', () => {
    expect(parseProfile('')).toBeNull();
    expect(parseProfile(undefined)).toBeNull();
    expect(parseProfile('not json')).toBeNull();
    expect(parseProfile('[1,2,3]')).toBeNull();
  });
});

describe('renderProfileBlock', () => {
  it('renders a USER PROFILE block listing non-empty fields', () => {
    const block = renderProfileBlock('{"name":"Jane Doe","email":"jane@x.com","phone":""}');
    expect(block).toContain('USER PROFILE');
    expect(block).toContain('- name: Jane Doe');
    expect(block).toContain('- email: jane@x.com');
    expect(block).not.toContain('phone'); // empty values skipped
  });
  it('is undefined when there is no usable profile', () => {
    expect(renderProfileBlock('')).toBeUndefined();
    expect(renderProfileBlock('{}')).toBeUndefined();
    expect(renderProfileBlock('garbage')).toBeUndefined();
  });
});

describe('buildProfileExtractionMessages', () => {
  it('includes the résumé text and asks for JSON only', () => {
    const msgs = buildProfileExtractionMessages('Jane Doe — Senior Engineer at Acme');
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('JSON');
    expect(msgs[1].content).toContain('Jane Doe — Senior Engineer at Acme');
  });
  it('truncates very long résumé text', () => {
    const msgs = buildProfileExtractionMessages('x'.repeat(20_000));
    expect(msgs[1].content.length).toBeLessThan(17_000);
  });
});

describe('normalizeExtractedProfile', () => {
  it('cleans the model JSON, dropping empty fields, into pretty JSON', () => {
    const out = normalizeExtractedProfile('{"name":"Jane","email":"j@x.com","phone":"","skills":[]}');
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed).toEqual({ name: 'Jane', email: 'j@x.com' });
  });
  it('tolerates JSON wrapped in prose/fences and returns null when unusable', () => {
    expect(normalizeExtractedProfile('here you go: {"name":"Jane"} done')).toContain('Jane');
    expect(normalizeExtractedProfile('no json here')).toBeNull();
    expect(normalizeExtractedProfile('{}')).toBeNull();
  });
});
