import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tabUploadFileTool } from '@/agent/tools/browser/upload';
import { saveResumeFile } from '@/background/state_store';
import { resetStorage } from '../helpers';
import type { ToolContext } from '@/agent/tools/registry';

function ctx(): ToolContext {
  return {
    taskId: 't',
    signal: new AbortController().signal,
    hot: {} as never,
    settings: { domainTiers: { 'jobs.lever.co': 'click-only' } } as never,
    ollama: {} as never,
    emit: () => {},
    addFinding: async () => {},
  };
}

function mockChrome(sendImpl: (method: string) => unknown) {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: { get: (_id: number, cb: (t: { url: string }) => void) => cb({ url: 'https://jobs.lever.co/acme/1' }) },
    debugger: {
      attach: (_t: unknown, _v: unknown, cb: () => void) => cb(),
      detach: (_t: unknown, cb: () => void) => cb(),
      sendCommand: (_t: unknown, method: string, _p: unknown, cb: (r?: unknown) => void) => cb(sendImpl(method)),
    },
    runtime: { lastError: undefined },
  };
}

describe('tab.upload_file dispatch', () => {
  beforeEach(async () => {
    await resetStorage();
  });
  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it('fails clearly when no résumé is stored', async () => {
    mockChrome(() => ({}));
    const r = await tabUploadFileTool.dispatch({ tabId: 1 }, ctx());
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/no résumé stored/i);
  });

  it('attaches the résumé when a file input is found', async () => {
    await saveResumeFile({ name: 'r.pdf', mime: 'application/pdf', base64: 'QUJD' });
    mockChrome((method) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'obj-1', subtype: 'node' } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: { fileName: 'r.pdf', count: 1, accept: '.pdf' } } };
      return {};
    });
    const r = await tabUploadFileTool.dispatch({ tabId: 1 }, ctx());
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ fileName: 'r.pdf', count: 1 });
  });

  it('fails when there is no file input on the page', async () => {
    await saveResumeFile({ name: 'r.pdf', mime: 'application/pdf', base64: 'QUJD' });
    mockChrome((method) => {
      if (method === 'Runtime.evaluate') return { result: { subtype: 'null' } };
      return {};
    });
    const r = await tabUploadFileTool.dispatch({ tabId: 1 }, ctx());
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/no <input type=file>/i);
  });
});
