import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Settings } from '@/shared/messages';
import { DEFAULT_SETTINGS } from '@/shared/messages';
import { OllamaClient } from '@/background/ollama';
import { budgetsFor, capsFor, DEFAULT_NUM_CTX } from '@/agent/budget';
import { assertAccessPolicy, assertCanAct, DomainTierError } from '@/agent/safety/domain_tiers';
import { redactDeep, redactEvent } from '@/agent/safety/redact';
import { pageFetchTool } from '@/agent/tools/browser/page';

describe('limitedResources gate (Task 1)', () => {
  it('defaults limitedResources to false — safe by default', () => {
    expect(DEFAULT_SETTINGS.limitedResources).toBe(false);
  });

  it('a Partial<Settings> missing limitedResources merges to the baseline', () => {
    const partial: Partial<Settings> = { ...DEFAULT_SETTINGS };
    delete partial.limitedResources;
    expect(partial.limitedResources).toBeUndefined();
    expect({ limitedResources: false, ...partial }).toEqual(DEFAULT_SETTINGS);
  });
});

describe('limitedResources budgets (Task 2)', () => {
  it('off path is byte-identical: executor baseline 26000', () => {
    expect(budgetsFor(DEFAULT_NUM_CTX).executor).toBe(26_000);
  });

  it('on: every role budget capped at 4096', () => {
    const b = budgetsFor(DEFAULT_NUM_CTX, true);
    for (const role of ['planner', 'executor', 'evaluator', 'compactor'] as const) {
      expect(b[role]).toBeLessThanOrEqual(4_096);
    }
  });

  it('on: page cap stays fixed at 12000', () => {
    expect(capsFor(DEFAULT_NUM_CTX, true).page).toBe(12_000);
  });
});

interface CapturedBody {
  keep_alive: string;
  options: Record<string, unknown>;
  [key: string]: unknown;
}

describe('OllamaClient chat body (Task 3)', () => {
  let origFetch: typeof globalThis.fetch;
  let origKeepAlive: string | undefined;
  let origCtxLen: string | undefined;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    origKeepAlive = process.env.OLLAMA_KEEP_ALIVE;
    origCtxLen = process.env.OLLAMA_CONTEXT_LENGTH;
    delete process.env.OLLAMA_KEEP_ALIVE;
    delete process.env.OLLAMA_CONTEXT_LENGTH;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    if (origKeepAlive === undefined) delete process.env.OLLAMA_KEEP_ALIVE;
    else process.env.OLLAMA_KEEP_ALIVE = origKeepAlive;
    if (origCtxLen === undefined) delete process.env.OLLAMA_CONTEXT_LENGTH;
    else process.env.OLLAMA_CONTEXT_LENGTH = origCtxLen;
  });

  async function captureBody(opts: Parameters<OllamaClient['chatOnce']>[0]): Promise<CapturedBody> {
    let raw: string | null = null;
    globalThis.fetch = ((async (_input: RequestInfo | URL, init?: RequestInit) => {
      raw = init?.body ? String(init.body) : null;
      return {
        ok: true,
        json: async () => ({ message: { role: 'assistant', content: 'ok', done: true } }),
      } as unknown as Response;
    }) as typeof globalThis.fetch);
    await new OllamaClient('http://localhost:11434').chatOnce(opts);
    if (!raw) throw new Error('no request body captured');
    return (JSON.parse(raw) as unknown) as CapturedBody;
  }

  it('defaults body temperature to 1.0', async () => {
    const body = await captureBody({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(body.options.temperature).toBe(1.0);
  });

  it('omits format unless opts.format is set', async () => {
    const body = await captureBody({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect('format' in body).toBe(false);
  });

  it('contains no KV key', async () => {
    const body = await captureBody({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect('kv' in body).toBe(false);
  });

  it('keep_alive defaults to 10m when OLLAMA_KEEP_ALIVE is unset', async () => {
    const body = await captureBody({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(body.keep_alive).toBe('10m');
  });

  it('keep_alive honors OLLAMA_KEEP_ALIVE', async () => {
    process.env.OLLAMA_KEEP_ALIVE = '5m';
    const body = await captureBody({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(body.keep_alive).toBe('5m');
  });

  it('num_ctx is ceiled by OLLAMA_CONTEXT_LENGTH', async () => {
    process.env.OLLAMA_CONTEXT_LENGTH = '4096';
    const body = await captureBody({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      numCtx: 131_072,
    });
    expect(body.options.num_ctx).toBe(4096);
  });

  it('num_ctx falls back to opts.numCtx when OLLAMA_CONTEXT_LENGTH is non-numeric', async () => {
    process.env.OLLAMA_CONTEXT_LENGTH = 'not-a-number';
    const body = await captureBody({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      numCtx: 131_072,
    });
    expect(body.options.num_ctx).toBe(131_072);
  });
});

type Tier = 'read-only' | 'click-only';
type PolicyCase = [string, Tier, Record<string, Tier>, boolean];

const POLICY_CASES: PolicyCase[] = [
  ['https://example.com/page', 'read-only', {}, false],
  ['https://example.com/page', 'click-only', {}, false],
  ['https://example.com/page', 'click-only', {}, true],
  ['https://example.com/page', 'click-only', { 'example.com': 'click-only' }, false],
  ['https://example.com/page', 'read-only', { 'example.com': 'click-only' }, false],
  ['https://example.com/page', 'click-only', { 'example.com': 'read-only' }, false],
  ['https://example.com/page', 'click-only', { 'example.com': 'read-only' }, true],
  ['javascript:alert(1)', 'click-only', {}, false],
  ['javascript:alert(1)', 'click-only', {}, true],
  ['file:///etc/passwd', 'read-only', {}, true],
  ['chrome://extensions', 'read-only', {}, false],
];

describe('assertAccessPolicy (canonical) == assertCanAct (delegation) — matrix', () => {
  it.each(POLICY_CASES)(
    'identical outcome for url=%s required=%s bypass=%s',
    (url, required, tiers, bypass) => {
      const outcome = (fn: (u: string, r: Tier, t: Record<string, Tier>, b: boolean) => void) => {
        try {
          fn(url, required, tiers, bypass);
          return 'ok';
        } catch (e) {
          return e instanceof DomainTierError ? 'tier-error' : String(e);
        }
      };
      expect(outcome(assertAccessPolicy)).toBe(outcome(assertCanAct));
    },
  );
});

describe('assertAccessPolicy — blocklist wins before bypass', () => {
  it('blocked URL throws even when bypass is true (blocklist first)', () => {
    expect(() => assertAccessPolicy('file:///etc/passwd', 'read-only', {}, true)).toThrow(
      DomainTierError,
    );
    expect(() => assertAccessPolicy('javascript:alert(1)', 'click-only', {}, true)).toThrow(
      DomainTierError,
    );
  });
  it('assertCanAct delegates with identical behavior', () => {
    expect(() => assertCanAct('file:///etc/passwd', 'read-only', {}, true)).toThrow(DomainTierError);
  });
});

describe('redactDeep maxDepth 16 (limitedResources redaction cap)', () => {
  function nest(depth: number, leaf = 'safe-leaf-value'): { next?: unknown; leaf?: string } {
    let node: { next?: unknown; leaf?: string } = { leaf };
    for (let i = 0; i < depth; i++) node = { next: node };
    return node;
  }

  it('25-deep nesting yields [redacted: too deep] without throwing (cap is 16)', () => {
    expect(() => redactDeep(nest(25))).not.toThrow();
    expect(JSON.stringify(redactDeep(nest(25)))).toContain('[redacted: too deep]');
  });

  it('15-deep nesting still walks to the leaf (leaf string is processed at depth 16, within the cap)', () => {
    const out = JSON.stringify(redactDeep(nest(15)));
    expect(out).not.toContain('[redacted: too deep]');
    expect(out).toContain('safe-leaf-value');
  });
  it('16-deep nesting caps at the leaf string ([redacted: too deep] at depth 17)', () => {
    expect(JSON.stringify(redactDeep(nest(16)))).toContain('[redacted: too deep]');
  });

  it('redactEvent remains capped at depth 8 (unchanged)', () => {
    const ev = { kind: 'tool.call', ts: 0, tool: 'x', args: nest(12) } as unknown;
    expect(() => redactEvent(ev)).not.toThrow();
    expect(JSON.stringify(redactEvent(ev))).toContain('[redacted: too deep]');
  });
});

describe('page.fetch SSRF — requested URL plus response.url after redirect', () => {
  let origFetch: typeof globalThis.fetch;
  beforeEach(() => {
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  function staged(response: unknown): typeof globalThis.fetch {
    return ((async () => response) as unknown) as typeof globalThis.fetch;
  }

  const publicCtx = {
    settings: { domainTiers: { 'example.com': 'click-only' }, bypassDomainTiers: false },
  } as unknown as Parameters<typeof pageFetchTool.dispatch>[1];

  it('public fetch on a click-only tiered host returns the body', async () => {
    globalThis.fetch = staged(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await pageFetchTool.dispatch({ url: 'https://example.com/api' }, publicCtx);
    expect(res.ok).toBe(true);
    expect(res.content).toContain('ok');
  });

  it('private requested URL is blocked before fetch is attempted', async () => {
    let called = false;
    globalThis.fetch = staged(() => {
      called = true;
      return new Response('');
    });
    const res = await pageFetchTool.dispatch(
      { url: 'http://127.0.0.1:8080/internal' },
      publicCtx,
    );
    expect(called).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.content).toContain('SSRF guard');
  });

  it('redirect target (response.url) is re-checked and blocked even when the requested URL is public', async () => {
    const fake = {
      url: 'http://127.0.0.1:8080/internal',
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'text/plain' },
      text: async () => 'SECRET INTERNAL DATA',
    } as unknown as Response;
    globalThis.fetch = staged(fake);
    const res = await pageFetchTool.dispatch(
      { url: 'https://example.com/redirect' },
      publicCtx,
    );
    expect(res.ok).toBe(false);
    expect(res.content).toContain('SSRF guard');
    expect(res.content).not.toContain('SECRET INTERNAL DATA');
  });

  it('manual redirect public->public follows hops and returns the body', async () => {
    const redirectRes = {
      url: 'https://example.com/redirect',
      status: 302,
      statusText: 'Found',
      headers: { get: (key: string) => (key === 'location' ? 'https://example.com/target' : null) },
    } as unknown as Response;
    const targetRes = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
    });
    let calls = 0;
    globalThis.fetch = ((async () => {
      calls++;
      return calls === 1 ? redirectRes : targetRes;
    }) as unknown) as typeof globalThis.fetch;
    const res = await pageFetchTool.dispatch({ url: 'https://example.com/redirect' }, publicCtx);
    expect(calls).toBe(2); // redirect followed once, then body read
    expect(res.ok).toBe(true);
    expect(res.content).toContain('ok');
  });

  it('manual redirect public->private is blocked before the body is read', async () => {
    const redirectRes = {
      url: 'https://example.com/redirect',
      status: 302,
      statusText: 'Found',
      headers: { get: (key: string) => (key === 'location' ? 'http://127.0.0.1:8080/internal' : null) },
    } as unknown as Response;
    let bodyRead = false;
    let calls = 0;
    globalThis.fetch = ((async () => {
      calls++;
      if (calls === 1) return redirectRes;
      bodyRead = true;
      return new Response('SECRET INTERNAL DATA', { status: 200, headers: { 'content-type': 'text/plain' } });
    }) as unknown) as typeof globalThis.fetch;
    const res = await pageFetchTool.dispatch({ url: 'https://example.com/redirect' }, publicCtx);
    expect(calls).toBe(1); // second fetch never attempted
    expect(bodyRead).toBe(false); // body never touched for a blocked redirect target
    expect(res.ok).toBe(false);
    expect(res.content).toContain('SSRF guard');
    expect(res.content).not.toContain('SECRET INTERNAL DATA');
  });
});
