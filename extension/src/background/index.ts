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
import { Orchestrator, type OrchestratorOpts } from '@/agent/orchestrator';
import { buildRegistry } from '@/agent/tools';
import { buildProfileExtractionMessages, normalizeExtractedProfile } from '@/agent/profile';
import { NUM_CTX } from '@/agent/budget';
import { metricsSnapshot } from '@/agent/metrics';
import { persistTimeline, loadTimeline, clearPersistedTimeline } from './timeline_store';

let _orch: Orchestrator | null = null;
// Synchronous start-guard: handleStart awaits ping/listModels before _orch is set, so two
// fast clicks could both pass the `if (_orch)` check and spawn a second, orphaned run.
let _starting = false;
// Monotonic run id. A run is detached (not awaited) and only aborts at the next checkpoint, so
// after abort/watchdog nulls _orch a NEW run can start while the old one is still unwinding. Each
// run captures its id; the old run's abort/finally/emit must check it still OWNS the current run
// before mutating shared state (_orch, keepalive, _events) — else it tears down the new run.
let _runId = 0;
let _abortController: AbortController | null = null;
let _keepAlive: ReturnType<typeof setInterval> | null = null;
let _events: TimelineEvent[] = [];
const _panels = new Set<chrome.runtime.Port>();

// Orchestrator factory — overridable in tests to drive the run lifecycle (start/abort/finish
// overlap) without a real model. Production always builds a real Orchestrator.
let _makeOrchestrator: (opts: OrchestratorOpts) => Orchestrator = (opts) => new Orchestrator(opts);
function makeOrchestrator(opts: OrchestratorOpts): Orchestrator {
  return _makeOrchestrator(opts);
}

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
  persistTimeline(_events); // mirror to storage.session so the trace survives an SW kill
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
    // 8 min, not 5: the planner alone can take up to 300s (5 min); a 5-min stale
    // threshold could abort a healthy long turn. 8 leaves a margin past that ceiling.
    const stale = Date.now() - hot.lastTouch > 8 * 60_000;
    if (stale && hot.phase !== 'IDLE' && hot.phase !== 'DONE' && hot.phase !== 'ABORTED') {
      console.warn('[browser-agent] watchdog: stale task — aborting');
      _runId += 1; // supersede: the stale run's detached finally must not tear down a successor
      _abortController?.abort(new DOMException('Watchdog stale', 'TimeoutError'));
      const dying = _orch;
      _orch = null;
      _abortController = null;
      stopKeepAlive();
      if (dying) await dying.abort('Watchdog: lastTouch stale');
    }
  });
}

(async () => {
  try {
    const hot = await loadHot();
    if (hot && hot.phase !== 'IDLE' && hot.phase !== 'DONE' && hot.phase !== 'ABORTED') {
      console.warn('[browser-agent] crash-resume: found in-flight task, marking ABORTED');
      await clearHot();
    }
  } catch (err) {
    // Never let SW-startup state recovery become an unhandled rejection.
    console.warn('[browser-agent] crash-resume failed:', (err as Error)?.message);
  }
})();

async function handleStart(goal: string, seedPlan?: OrchestratorOpts['seedPlan']) {
  log('handleStart goal=', JSON.stringify(goal));
  if (_orch || _starting) {
    log('handleStart: a task is already running — rejecting');
    broadcast({ type: 'error', message: 'A task is already running. Stop it first.' });
    return;
  }
  _starting = true; // held only across the preflight await window, until _orch is set
  const settings = await loadSettings();
  const ollama = new OllamaClient(settings.ollamaBaseUrl);

  log('pinging Ollama at', settings.ollamaBaseUrl);
  const ok = await ollama.ping();
  log('ping result =', ok);
  if (!ok) {
    _starting = false;
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
    _starting = false;
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

  const myRun = ++_runId; // claim this run; teardown below only acts if it still owns _runId
  _events = [];
  clearPersistedTimeline(); // a fresh run must not let an SW kill resurrect the previous trace
  broadcast({ type: 'timeline', events: _events });

  const registry = buildRegistry();
  _abortController = new AbortController();
  _orch = makeOrchestrator({
    ollama,
    registry,
    settings,
    seedPlan,
    emit: (ev) => {
      if (myRun === _runId) appendEventLocal(ev); // a superseded run must not pollute the live timeline
    },
    signal: _abortController.signal,
  });
  _starting = false; // _orch is now set; the `if (_orch)` guard takes over from here

  startKeepAlive(); // keep the SW alive across long (>30s) Ollama generations
  try {
    const initial = await _orch.start(goal);
    await pushStatus();
    const result = await _orch.runUntilTerminal(initial);
    console.log('[browser-agent] task complete:', result);
  } catch (err) {
    if (myRun === _runId) {
      appendEventLocal({
        kind: 'log',
        ts: Date.now(),
        level: 'error',
        message: `Orchestrator error: ${(err as Error).message}`,
      });
      if (_orch) await _orch.abort((err as Error).message);
    }
  } finally {
    // Only tear down if WE are still the current run. After an abort/watchdog started a newer run,
    // this (now-stale) finally must not stop the new run's keepalive or null its _orch.
    if (myRun === _runId) {
      stopKeepAlive();
      _orch = null;
      _abortController = null;
      await pushStatus();
      await pushMetrics();
    }
  }
}

async function handleAbort() {
  if (!_orch) return;
  _runId += 1; // supersede the in-flight run so its detached finally/emit become no-ops
  _abortController?.abort(new DOMException('User aborted', 'AbortError'));
  const dying = _orch;
  _orch = null;
  _abortController = null;
  stopKeepAlive();
  await dying.abort('User aborted');
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
      // The SW may have been killed since the last run, emptying the in-memory timeline. Restore
      // it from storage.session so the finished run's Activity log + Copy button reappear.
      if (_events.length === 0) {
        const saved = await loadTimeline();
        if (saved.length) _events = saved;
      }
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
          case 'agent.askPage':
            // "Ask this page" fast path: seed a 1-step read-the-current-page-and-answer plan so
            // the planner (slowest call) is skipped. The goal IS the question; tab.read_active
            // pulls the user's active tab on-device.
            void handleStart(cmd.question, [
              {
                description: `Read the current page (tab.read_active) and answer the user's question, citing only what the page actually says: ${cmd.question}`,
                successCriteria: 'answered the question from the current page, or said it is not on the page',
                toolHint: 'tab.read_active',
              },
            ]);
            break;
          case 'agent.abort':
            await handleAbort();
            break;
          case 'agent.steer':
            // Mid-run correction: hand it to the live orchestrator (no-op if nothing is running).
            _orch?.steer(cmd.text);
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

// Test-only: drive the run lifecycle with a fake Orchestrator and inspect/await shared state.
// Production never touches this; the real path always uses `new Orchestrator`.
export const _testing = {
  handleStart,
  handleAbort,
  setOrchestratorFactory(fn: ((opts: OrchestratorOpts) => Orchestrator) | null) {
    _makeOrchestrator = fn ?? ((opts) => new Orchestrator(opts));
  },
  state: () => ({ orchSet: _orch !== null, runId: _runId, starting: _starting, keepAlive: _keepAlive !== null, events: _events.length }),
  reset() {
    _orch = null;
    _abortController = null;
    _starting = false;
    _runId = 0;
    _events = [];
    stopKeepAlive();
  },
};

export {};
