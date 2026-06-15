// Service Worker entry. Owns the orchestrator, dispatches panel commands,
// streams updates back via long-lived port. Pre-flight Ollama on agent.start.

import { OllamaClient } from './ollama';
import {
  clearHot,
  loadHot,
  loadSettings,
  saveResumeFile,
  saveSettings,
  setDomainTier,
  toStatus,
} from './state_store';
import {
  type PanelCommand,
  PORT_NAME,
  sameModel,
  type SwUpdate,
  type TimelineEvent,
} from '@/shared/messages';
import { Orchestrator } from '@/agent/orchestrator';
import { buildRegistry } from '@/agent/tools';
import { buildProfileExtractionMessages, normalizeExtractedProfile } from '@/agent/profile';
import { NUM_CTX } from '@/agent/budget';
import { metricsSnapshot } from '@/agent/metrics';

let _orch: Orchestrator | null = null;
let _abortController: AbortController | null = null;
let _keepAlive: ReturnType<typeof setInterval> | null = null;
let _events: TimelineEvent[] = [];
const _panels = new Set<chrome.runtime.Port>();

// Boundary logging — visible in the service-worker console. Prefix [BA].
const log = (...a: unknown[]) => console.log('[BA]', ...a);
log('service worker loaded');

// Chrome MV3 terminates an idle service worker after 30s of inactivity. A single
// awaited fetch() does NOT count as activity, so a long Ollama generation (12b at
// ~14 t/s easily exceeds 30s) gets the SW killed mid-request — Ollama then logs
// "cancel task" + HTTP 500 at ~30s. Since Chrome 114 an open port no longer resets
// the timer either; only extension API calls and port messages do. So while a task
// runs we ping a cheap API every 20s (10s margin under the 30s limit). State writes
// (chrome.storage) reset the timer between LLM calls; this covers the gap *during*
// one long generation, which is the only unguarded window.
function startKeepAlive() {
  if (_keepAlive !== null) return;
  _keepAlive = setInterval(() => {
    try {
      chrome.runtime.getPlatformInfo(() => void chrome.runtime?.lastError);
    } catch {
      /* worker may be tearing down — nothing to do */
    }
  }, 20_000);
  log('keepalive started (ping every 20s)');
}

function stopKeepAlive() {
  if (_keepAlive === null) return;
  clearInterval(_keepAlive);
  _keepAlive = null;
  log('keepalive stopped');
}

function broadcast(msg: SwUpdate) {
  for (const port of _panels) {
    try {
      port.postMessage(msg);
    } catch {
      _panels.delete(port);
    }
  }
}

function appendEventLocal(ev: TimelineEvent) {
  _events.push(ev);
  if (_events.length > 1_000) _events = _events.slice(-1_000);
  broadcast({ type: 'append', event: ev });
}

async function pushStatus() {
  const hot = await loadHot();
  broadcast({ type: 'status', status: toStatus(hot) });
}

async function pushMetrics() {
  broadcast({ type: 'metrics', metrics: metricsSnapshot() });
}

if (typeof chrome !== 'undefined' && chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => undefined);
}

if (typeof chrome !== 'undefined' && chrome.action?.onClicked) {
  chrome.action.onClicked.addListener((tab) => {
    if (tab?.windowId !== undefined && chrome.sidePanel?.open) {
      chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
    }
  });
}

if (typeof chrome !== 'undefined' && chrome.alarms) {
  chrome.alarms.create('agent.watchdog', { periodInMinutes: 5 });
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== 'agent.watchdog') return;
    const hot = await loadHot();
    if (!hot) return;
    const stale = Date.now() - hot.lastTouch > 5 * 60_000;
    if (stale && hot.phase !== 'IDLE' && hot.phase !== 'DONE' && hot.phase !== 'ABORTED') {
      console.warn('[browser-agent] watchdog: stale task — aborting');
      _abortController?.abort(new DOMException('Watchdog stale', 'TimeoutError'));
      if (_orch) await _orch.abort('Watchdog: lastTouch stale');
    }
  });
}

(async () => {
  const hot = await loadHot();
  if (hot && hot.phase !== 'IDLE' && hot.phase !== 'DONE' && hot.phase !== 'ABORTED') {
    console.warn('[browser-agent] crash-resume: found in-flight task, marking ABORTED');
    await clearHot();
  }
})();

async function handleStart(goal: string) {
  log('handleStart goal=', JSON.stringify(goal));
  if (_orch) {
    log('handleStart: a task is already running — rejecting');
    broadcast({ type: 'error', message: 'A task is already running. Stop it first.' });
    return;
  }
  const settings = await loadSettings();
  const ollama = new OllamaClient(settings.ollamaBaseUrl);

  log('pinging Ollama at', settings.ollamaBaseUrl);
  const ok = await ollama.ping();
  log('ping result =', ok);
  if (!ok) {
    broadcast({
      type: 'preflight',
      ok: false,
      details: { error: `Ollama unreachable at ${settings.ollamaBaseUrl}` },
    });
    return;
  }
  const models = await ollama.listModels();
  log('installed models =', models);
  const required = [
    settings.executorModel,
    settings.plannerModel,
    settings.evaluatorModel,
    settings.compactorModel,
  ];
  const missing = required.filter((m) => !models.some((x) => sameModel(x, m)));
  if (missing.length) {
    log('missing models =', missing);
    broadcast({
      type: 'preflight',
      ok: false,
      details: { error: `Missing models: ${missing.join(', ')}`, hint: `Run: ollama pull ${missing.join(' && ollama pull ')}` },
    });
    return;
  }
  log('preflight OK — starting orchestrator');
  broadcast({ type: 'preflight', ok: true, details: { models } });

  _events = [];
  broadcast({ type: 'timeline', events: _events });

  const registry = buildRegistry();
  _abortController = new AbortController();
  _orch = new Orchestrator({
    ollama,
    registry,
    settings,
    emit: appendEventLocal,
    signal: _abortController.signal,
  });

  startKeepAlive(); // keep the SW alive across long (>30s) Ollama generations
  try {
    const initial = await _orch.start(goal);
    await pushStatus();
    const result = await _orch.runUntilTerminal(initial);
    console.log('[browser-agent] task complete:', result);
  } catch (err) {
    appendEventLocal({
      kind: 'log',
      ts: Date.now(),
      level: 'error',
      message: `Orchestrator error: ${(err as Error).message}`,
    });
    if (_orch) await _orch.abort((err as Error).message);
  } finally {
    stopKeepAlive();
    _orch = null;
    _abortController = null;
    await pushStatus();
    await pushMetrics();
  }
}

async function handleAbort() {
  if (!_orch) return;
  _abortController?.abort(new DOMException('User aborted', 'AbortError'));
  await _orch.abort('User aborted');
  _orch = null;
  _abortController = null;
  await pushStatus();
}

async function handlePreflight() {
  const settings = await loadSettings();
  const ollama = new OllamaClient(settings.ollamaBaseUrl);
  const ok = await ollama.ping();
  if (!ok) {
    broadcast({
      type: 'preflight',
      ok: false,
      details: { error: `Ollama unreachable at ${settings.ollamaBaseUrl}` },
    });
    return;
  }
  const models = await ollama.listModels();
  const required = [
    settings.executorModel,
    settings.plannerModel,
    settings.evaluatorModel,
    settings.compactorModel,
  ];
  const missing = required.filter((m) => !models.some((x) => sameModel(x, m)));
  broadcast({
    type: 'preflight',
    ok: missing.length === 0,
    details: missing.length ? { error: `Missing: ${missing.join(', ')}`, available: models } : { models },
  });
}

async function handleProfileExtract(resumeText: string) {
  // The model call can exceed the 30s SW idle limit; keep alive while it runs
  // (unless an agent task is already keeping the worker alive).
  const startedKeepAlive = _keepAlive === null;
  if (startedKeepAlive) startKeepAlive();
  try {
    const settings = await loadSettings();
    const ollama = new OllamaClient(settings.ollamaBaseUrl);
    if (!(await ollama.ping())) {
      broadcast({ type: 'profileExtracted', ok: false, error: `Ollama unreachable at ${settings.ollamaBaseUrl}` });
      return;
    }
    log('extracting profile from résumé text, chars =', resumeText.length);
    const resp = await ollama.chatOnce({
      model: settings.executorModel,
      messages: buildProfileExtractionMessages(resumeText),
      format: 'json',
      thinking: false,
      numCtx: NUM_CTX,
      timeoutMs: 120_000,
    });
    const profileJson = normalizeExtractedProfile(resp.message.content ?? '');
    if (!profileJson) {
      broadcast({ type: 'profileExtracted', ok: false, error: 'Could not extract any fields from that résumé.' });
      return;
    }
    broadcast({ type: 'profileExtracted', ok: true, profileJson });
  } catch (err) {
    broadcast({ type: 'profileExtracted', ok: false, error: `Extraction failed: ${(err as Error).message}` });
  } finally {
    if (startedKeepAlive) stopKeepAlive();
  }
}

async function handleResumeStore(name: string, mime: string, base64: string) {
  try {
    await saveResumeFile({ name, mime, base64 });
    broadcast({ type: 'resumeStored', ok: true, name });
  } catch (err) {
    broadcast({ type: 'resumeStored', ok: false, error: `Could not store résumé: ${(err as Error).message}` });
  }
}

async function handleListModels() {  const settings = await loadSettings();
  const ollama = new OllamaClient(settings.ollamaBaseUrl);
  const ok = await ollama.ping();
  if (!ok) {
    broadcast({
      type: 'models',
      ok: false,
      models: [],
      error: `Ollama unreachable at ${settings.ollamaBaseUrl}. Is "ollama serve" running?`,
    });
    return;
  }
  const models = await ollama.listModels();
  broadcast({ type: 'models', ok: true, models });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onConnect) {
  chrome.runtime.onConnect.addListener((port) => {
    log('onConnect from port:', port.name);
    if (port.name !== PORT_NAME) return;
    _panels.add(port);
    void (async () => {
      const settings = await loadSettings();
      const hot = await loadHot();
      port.postMessage({ type: 'settings', settings } satisfies SwUpdate);
      port.postMessage({ type: 'status', status: toStatus(hot) } satisfies SwUpdate);
      port.postMessage({ type: 'timeline', events: _events } satisfies SwUpdate);
      port.postMessage({ type: 'metrics', metrics: metricsSnapshot() } satisfies SwUpdate);
    })();
    port.onMessage.addListener(async (cmd: PanelCommand) => {
      log('command received:', cmd.type);
      try {
        switch (cmd.type) {
          case 'agent.start':
            // Detached on purpose (NOT awaited). Chrome force-kills a single
            // onMessage handler at the 5-minute event-execution cap; a long
            // multi-step run (12b at ~14 t/s) blows past that. Returning from the
            // listener immediately ends the event, escaping the 5-min window — the
            // orchestrator then runs as a top-level task sustained by the 20s
            // keepalive, with no cumulative SW lifetime limit. handleStart has its
            // own try/catch/finally, so detaching loses no error handling.
            void handleStart(cmd.goal);
            break;
          case 'agent.abort':
            await handleAbort();
            break;
          case 'agent.status':
            await pushStatus();
            break;
          case 'settings.get':
            broadcast({ type: 'settings', settings: await loadSettings() });
            break;
          case 'settings.set':
            broadcast({ type: 'settings', settings: await saveSettings(cmd.settings) });
            break;
          case 'domainTier.set':
            broadcast({ type: 'settings', settings: await setDomainTier(cmd.host, cmd.tier) });
            break;
          case 'profile.extract':
            void handleProfileExtract(cmd.resumeText);
            break;
          case 'resume.store':
            void handleResumeStore(cmd.name, cmd.mime, cmd.base64);
            break;
          case 'models.list':
            await handleListModels();
            break;
          case 'preflight':
            await handlePreflight();
            break;
          default:
            broadcast({ type: 'error', message: `Unknown command: ${(cmd as { type: string }).type}` });
        }
      } catch (err) {
        broadcast({ type: 'error', message: `Command failed: ${(err as Error).message}` });
      }
    });
    port.onDisconnect.addListener(() => _panels.delete(port));
  });
}

export {};
