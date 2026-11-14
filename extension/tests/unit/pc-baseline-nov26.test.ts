import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OllamaClient } from '@/background/ollama';
import { DEFAULT_SETTINGS, sameModel } from '@/shared/messages';
import { budgetsFor, capsFor } from '@/agent/budget';
import {
  domClickSelectorTool,
  pageExpectTool,
  pageFetchTool,
  pageWaitForTool,
  pageWaitMutationTool,
} from '@/agent/tools/browser/page';
import { assertCanAct } from '@/agent/safety/domain_tiers';

describe('T0: Ollama baseUrl allowlist (loopback only)', () => {
  let client: OllamaClient;

  beforeEach(() => {
    client = new OllamaClient();
  });

  it('rejects private link-local 169.254', () => {
    expect(() => client.setBaseUrl('http://169.254.169.254:11434')).toThrow();
  });

  it('rejects non-loopback attacker host', () => {
    expect(() => client.setBaseUrl('http://attacker.example.com:11434')).toThrow();
  });

  it('rejects userinfo even on loopback', () => {
    expect(() => client.setBaseUrl('http://user:pass@localhost:11434')).toThrow();
  });

  it('rejects other protocols', () => {
    expect(() => client.setBaseUrl('https://attacker.example.com')).toThrow();
    expect(() => client.setBaseUrl('file:///etc/passwd')).toThrow();
  });

  it('accepts http://localhost', () => {
    client.setBaseUrl('http://localhost:11434');
    expect(client.baseUrl).toBe('http://localhost:11434');
  });

  it('accepts http://127.0.0.1', () => {
    client.setBaseUrl('http://127.0.0.1:11434');
    expect(client.baseUrl).toBe('http://127.0.0.1:11434');
  });

  it('accepts optional https loopback', () => {
    client.setBaseUrl('https://localhost:11434');
    expect(client.baseUrl).toBe('https://localhost:11434');
  });

  it('strips trailing slash on accepted url', () => {
    client.setBaseUrl('http://localhost:11434/');
    expect(client.baseUrl).toBe('http://localhost:11434');
  });

  it('rejects non-loopback host in constructor', () => {
    expect(() => new OllamaClient('http://attacker.example.com:11434')).toThrow();
  });

  it('accepts default localhost constructor', () => {
    expect(new OllamaClient().baseUrl).toBe('http://localhost:11434');
  });
});

describe('T1: DEFAULT_SETTINGS baseline (brain/body split)', () => {
  it('brain model is gemma4:e4b-it-q4_K_M with standard thinking', () => {
    expect(DEFAULT_SETTINGS.agent?.brain.model).toBe('gemma4:e4b-it-q4_K_M');
    expect(DEFAULT_SETTINGS.agent?.brain.thinkingLevel).toBe('standard');
  });

  it('body model is gemma4:e2b-it-q4_K_M with thinking off', () => {
    expect(DEFAULT_SETTINGS.agent?.body.model).toBe('gemma4:e2b-it-q4_K_M');
    expect(DEFAULT_SETTINGS.agent?.body.thinkingLevel).toBe('off');
  });

  it('per-role windows: brain 32K quality, body 16K speed', () => {
    expect(DEFAULT_SETTINGS.agent?.brain.numCtx).toBe(32_768);
    expect(DEFAULT_SETTINGS.agent?.body.numCtx).toBe(16_384);
    // Brain budgets at 32K (quality path).
    expect(budgetsFor(32_768)).toEqual({
      planner: 30_000,
      executor: 26_000,
      evaluator: 28_000,
      compactor: 26_000,
    });
    // Body budgets at 16K (speed path, scale 0.5).
    expect(budgetsFor(16_384)).toEqual({
      planner: 15_000,
      executor: 13_000,
      evaluator: 14_000,
      compactor: 13_000,
    });
    // Brain caps at 32K.
    expect(capsFor(32_768)).toEqual({
      page: 12_000,
      scratch: 12_000,
      observed: 60_000,
      salvage: 24_000,
    });
    // Body caps at 16K: page fixed, cross-turn caps halve.
    expect(capsFor(16_384)).toEqual({
      page: 12_000,
      scratch: 6_000,
      observed: 30_000,
      salvage: 12_000,
    });
  });

  it('vision defaults to the e4b q4 tag', () => {
    expect(DEFAULT_SETTINGS.visionModel).toBe('gemma4:e4b-it-q4_K_M');
  });
});

describe('T2: sameModel equates e4b quant variants, splits e4b/e2b', () => {
  it('bare e4b equates its q4 tag (fallback sync)', () => {
    expect(sameModel('gemma4:e4b', 'gemma4:e4b-it-q4_K_M')).toBe(true);
  });
  it('e4b quant variants equate each other', () => {
    expect(sameModel('gemma4:e4b-it-q4_K_M', 'gemma4:e4b-it-q8_0')).toBe(true);
  });
  it('e4b vs e2b stay distinct (different weights)', () => {
    expect(sameModel('gemma4:e4b-it-q4_K_M', 'gemma4:e2b-it-q4_K_M')).toBe(false);
    expect(sameModel('gemma4:e4b', 'gemma4:e2b-it-q4_K_M')).toBe(false);
  });
});

describe('T3: click_selector + expect return graceful ok:false on blocked URL', () => {
  const blockedCtx = {
    settings: { domainTiers: {}, bypassDomainTiers: false },
  } as unknown as Parameters<typeof domClickSelectorTool.dispatch>[1];

  it('dom.click_selector returns ok:false (does not throw) for blocked URL', async () => {
    // No tab registered for 99999 → setup shim resolves undefined → url '' → blocked.
    const res = await domClickSelectorTool.dispatch({ tabId: 99999, selector: 'div' }, blockedCtx);
    expect(res.ok).toBe(false);
    expect(res.fatal).toBe(true);
  });

  it('page.expect returns ok:false (does not throw) for blocked URL', async () => {
    const ctx = blockedCtx as unknown as Parameters<typeof pageExpectTool.dispatch>[1];
    const res = await pageExpectTool.dispatch(
      { tabId: 99999, expression: 'true' },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.fatal).toBe(true);
  });
});

// Test helpers: stub chrome.tabs.get to resolve a fixed tab URL, and stub
// chrome.debugger.attach to fail fast (so a MISSING auth guard surfaces as a
// fast CdpError throw instead of a 20s CDP timeout hang).
function mockTabUrl(url: string): () => void {
  const origGet = chrome.tabs.get;
  chrome.tabs.get = ((id: number, cb: (t: unknown) => void) => {
    cb({ id, url, status: 'complete' });
  }) as unknown as typeof chrome.tabs.get;
  return () => {
    chrome.tabs.get = origGet;
  };
}

function mockDebuggerFailFast(): () => void {
  const dbg = chrome.debugger as unknown as { attach: unknown };
  const origAttach = dbg.attach;
  dbg.attach = ((...args: unknown[]) => {
    const cb = args[args.length - 1] as () => void;
    (chrome.runtime as { lastError?: unknown }).lastError = { message: 'No tab with given id' };
    cb();
    (chrome.runtime as { lastError?: unknown }).lastError = undefined;
  }) as unknown as typeof chrome.debugger.attach;
  return () => {
    dbg.attach = origAttach as typeof chrome.debugger.attach;
  };
}

describe('T4: page.wait_for + wait_for_mutation enforce domain-tier gating (auth)', () => {
  const tierCtx = {
    settings: { domainTiers: {}, bypassDomainTiers: false },
  } as unknown as Parameters<typeof pageWaitForTool.dispatch>[1];
  let restores: Array<() => void> = [];

  afterEach(() => {
    restores.forEach((r) => r());
    restores = [];
  });

  it('page.wait_for returns ok:false fatal:true on file:// tab (blocked scheme)', async () => {
    restores.push(mockTabUrl('file:///etc/passwd'));
    restores.push(mockDebuggerFailFast());
    const res = await pageWaitForTool.dispatch({ tabId: 4242, selector: '.results' }, tierCtx);
    expect(res.ok).toBe(false);
    expect(res.fatal).toBe(true);
  });

  it('page.wait_for_mutation returns ok:false fatal:true on file:// tab (blocked scheme)', async () => {
    const ctx = tierCtx as unknown as Parameters<typeof pageWaitMutationTool.dispatch>[1];
    restores.push(mockTabUrl('file:///etc/passwd'));
    restores.push(mockDebuggerFailFast());
    const res = await pageWaitMutationTool.dispatch({ tabId: 4242, selector: '.results' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.fatal).toBe(true);
  });

  it('page.wait_for denies read-only tier without reaching CDP', async () => {
    restores.push(mockTabUrl('https://unknown.example/page'));
    restores.push(mockDebuggerFailFast());
    const res = await pageWaitForTool.dispatch({ tabId: 4242, selector: '.results' }, tierCtx);
    expect(res.ok).toBe(false);
    expect(res.fatal).toBe(true);
  });

  it('page.wait_for_mutation denies read-only tier without reaching CDP', async () => {
    const ctx = tierCtx as unknown as Parameters<typeof pageWaitMutationTool.dispatch>[1];
    restores.push(mockTabUrl('https://unknown.example/page'));
    restores.push(mockDebuggerFailFast());
    const res = await pageWaitMutationTool.dispatch({ tabId: 4242 }, ctx);
    expect(res.ok).toBe(false);
    expect(res.fatal).toBe(true);
  });
});

describe('T5: blocked-branch errors carry hostname only (no URL/token leak)', () => {
  const tierCtx = {
    settings: { domainTiers: {}, bypassDomainTiers: false },
  } as unknown as Parameters<typeof domClickSelectorTool.dispatch>[1];
  let restores: Array<() => void> = [];

  afterEach(() => {
    restores.forEach((r) => r());
    restores = [];
  });

  it('assertCanAct blocked-scheme error does not echo path/query (token URL)', () => {
    let msg = '';
    try {
      assertCanAct('file:///etc/passwd?token=SECRET123', 'click-only', {});
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).not.toContain('SECRET123');
    expect(msg).not.toContain('/etc/passwd');
    expect(msg).not.toContain('?token=');
  });

  it('dom.click_selector on token-bearing blocked URL does not echo the token', async () => {
    restores.push(mockTabUrl('file:///tmp/x?code=SECRET456'));
    const res = await domClickSelectorTool.dispatch({ tabId: 4242, selector: 'div' }, tierCtx);
    expect(res.ok).toBe(false);
    expect(res.fatal).toBe(true);
    expect(JSON.stringify(res)).not.toContain('SECRET456');
  });

  it('page.expect on token-bearing blocked URL does not echo the token', async () => {
    const ctx = tierCtx as unknown as Parameters<typeof pageExpectTool.dispatch>[1];
    restores.push(mockTabUrl('file:///tmp/x?code=SECRET456'));
    const res = await pageExpectTool.dispatch({ tabId: 4242, expression: 'true' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.fatal).toBe(true);
    expect(JSON.stringify(res)).not.toContain('SECRET456');
  });

  it('page.fetch SSRF guard echoes hostname only for private target with token', async () => {
    const ctx = tierCtx as unknown as Parameters<typeof pageFetchTool.dispatch>[1];
    const res = await pageFetchTool.dispatch({ url: 'http://10.1.2.3/admin?token=SECRET789' }, ctx);
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain('SECRET789');
  });
});
