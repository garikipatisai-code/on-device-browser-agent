import { describe, expect, it } from 'vitest';
import { stripDataUri } from '@/agent/tools/browser/vision';
import { buildRegistry } from '@/agent/tools';

describe('stripDataUri', () => {
  it('strips a PNG data-URI prefix to raw base64', () => {
    expect(stripDataUri('data:image/png;base64,AAAB')).toBe('AAAB');
  });
  it('strips a JPEG data-URI prefix', () => {
    expect(stripDataUri('data:image/jpeg;base64,Zzz9')).toBe('Zzz9');
  });
  it('leaves already-bare base64 untouched', () => {
    expect(stripDataUri('AAAB')).toBe('AAAB');
  });
});

describe('vision tool registration', () => {
  it('vision.read is in the registry', () => {
    const r = buildRegistry();
    expect(r.has('vision.read')).toBe(true);
  });
  it('exposes a tool definition with tabId param', () => {
    const r = buildRegistry();
    const def = r.toolDefs((n) => n === 'vision.read')[0];
    expect(def.function.name).toBe('vision.read');
    const params = def.function.parameters as { properties: Record<string, unknown> };
    expect(params.properties.tabId).toBeDefined();
  });
});
