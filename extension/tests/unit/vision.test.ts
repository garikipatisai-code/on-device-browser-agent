import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripDataUri, visionReadTool } from '@/agent/tools/browser/vision';
import type { ToolContext } from '@/agent/tools/registry';
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

describe('vision.read capture (CDP, no focus steal)', () => {
  const BIG_B64 = 'iVBORw0KGgo'.padEnd(300, 'A'); // > 100 chars → a "real" capture
  let origDebugger: typeof chrome.debugger;
  let origUpdate: typeof chrome.tabs.update;
  let updateSpy: ReturnType<typeof vi.fn>;
  let sendSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    origDebugger = chrome.debugger;
    origUpdate = chrome.tabs.update;
    updateSpy = vi.fn((_id: number, _props: unknown, cb?: () => void) => cb?.());
    sendSpy = vi.fn((_t: unknown, method: string, _p: unknown, cb: (r?: unknown) => void) =>
      cb(method === 'Page.captureScreenshot' ? { data: BIG_B64 } : {}),
    );
    chrome.tabs.update = updateSpy as unknown as typeof chrome.tabs.update;
    chrome.debugger = {
      attach: (_t: unknown, _v: unknown, cb: () => void) => cb(),
      detach: (_t: unknown, cb: () => void) => cb(),
      sendCommand: sendSpy,
    } as unknown as typeof chrome.debugger;
  });
  afterEach(() => {
    chrome.debugger = origDebugger;
    chrome.tabs.update = origUpdate;
  });

  const ctx = () =>
    ({
      settings: { visionModel: 'gemma4:e4b' },
      ollama: { chatOnce: async () => ({ message: { content: 'Heading: Example. Button: Buy now.' } }) },
    }) as unknown as ToolContext;

  it('captures via CDP Page.captureScreenshot and never activates the tab', async () => {
    const res = await visionReadTool.dispatch({ tabId: 7 }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toContain('Buy now');
    expect(sendSpy).toHaveBeenCalledWith(
      expect.anything(),
      'Page.captureScreenshot',
      expect.anything(),
      expect.anything(),
    );
    expect(updateSpy).not.toHaveBeenCalled(); // no foreground activation → no focus steal
  });

  it('returns ok:false on an empty capture so the executor falls back to aria', async () => {
    sendSpy.mockImplementation((_t: unknown, _m: unknown, _p: unknown, cb: (r?: unknown) => void) => cb({ data: '' }));
    const res = await visionReadTool.dispatch({ tabId: 7 }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/empty|aria/i);
  });

  it('returns ok:false when CDP capture throws (e.g. attach fails)', async () => {
    chrome.debugger = undefined as unknown as typeof chrome.debugger;
    const res = await visionReadTool.dispatch({ tabId: 7 }, ctx());
    expect(res.ok).toBe(false);
  });
});
