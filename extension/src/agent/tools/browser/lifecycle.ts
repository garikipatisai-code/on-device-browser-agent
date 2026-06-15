// CDP lifecycle: attach → operate → detach. Singleton-safe.
// chrome.debugger is exclusive per tab — if DevTools is open, attach fails.
// One short retry on attach failure, then surface a typed error.

const PROTOCOL_VERSION = '1.3';
// A CDP command can hang forever if the renderer never responds (e.g. an input
// event on a still-loading or background tab). Without a cap, one hung command
// froze the whole agent for 9 minutes until the watchdog. Bound every command.
const CMD_TIMEOUT_MS = 20_000;
const ATTACH_TIMEOUT_MS = 10_000;

export class CdpError extends Error {
  fatal: boolean;
  constructor(message: string, fatal = false) {
    super(message);
    this.name = 'CdpError';
    this.fatal = fatal;
  }
}

export async function withCdp<T>(
  tabId: number,
  fn: (send: SendCmd) => Promise<T>,
  opts: { attachTimeoutMs?: number } = {},
): Promise<T> {
  if (typeof chrome === 'undefined' || !chrome.debugger) {
    throw new CdpError('chrome.debugger unavailable (not a Chrome extension context)', true);
  }
  const target: chrome.debugger.Debuggee = { tabId };
  await attach(target, PROTOCOL_VERSION, opts.attachTimeoutMs ?? 1500);
  try {
    const send: SendCmd = <T>(method: string, params?: Record<string, unknown>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new CdpError(`${method}: timed out after ${CMD_TIMEOUT_MS}ms (CDP command hung)`));
        }, CMD_TIMEOUT_MS);
        chrome.debugger.sendCommand(target, method, params, (result?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const err = chrome.runtime?.lastError;
          if (err) reject(new CdpError(`${method}: ${err.message ?? err}`));
          else resolve((result ?? {}) as T);
        });
      });
    return await fn(send);
  } finally {
    await detach(target).catch(() => undefined);
  }
}

export type SendCmd = <T = Record<string, unknown>>(
  method: string,
  params?: Record<string, unknown>,
) => Promise<T>;

function attachOnce(
  target: chrome.debugger.Debuggee,
  version: string,
  label: string,
  fatal: boolean,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new CdpError(`${label}: timed out after ${ATTACH_TIMEOUT_MS}ms`, fatal));
    }, ATTACH_TIMEOUT_MS);
    chrome.debugger.attach(target, version, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const err = chrome.runtime?.lastError;
      if (err) reject(new CdpError(`${label}: ${err.message ?? err}`, fatal));
      else resolve();
    });
  });
}

async function attach(target: chrome.debugger.Debuggee, version: string, retryDelayMs: number): Promise<void> {
  try {
    await attachOnce(target, version, 'attach', false);
  } catch (err) {
    await sleep(retryDelayMs);
    await attachOnce(target, version, 'attach (retry)', true);
    void err;
  }
}

async function detach(target: chrome.debugger.Debuggee): Promise<void> {
  return new Promise((resolve) => {
    chrome.debugger.detach(target, () => {
      void chrome.runtime?.lastError;
      resolve();
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
