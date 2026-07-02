// Resilient long-lived connection to the service worker.
//
// MV3 idle-kills the service worker after ~30s; its port then disconnects and any
// further postMessage is silently dropped — which is why "type a goal, hit Run,
// nothing happens" after the panel has sat idle. The panel used to null its port
// on disconnect and never reconnect. This client instead reconnects lazily on the
// next send() — which also wakes the SW — so the panel never goes permanently dead,
// while still letting the worker idle out when nothing is happening.

import { PORT_NAME, type PanelCommand, type SwUpdate } from '@/shared/messages';

export interface PortClient {
  /** Post a command, (re)connecting first if the port has gone away. */
  send: (cmd: PanelCommand) => void;
  /** Tear down the connection (component unmount). */
  disconnect: () => void;
  /** Register a callback fired whenever the SW port disconnects (e.g. mid-run SW death), so the
   *  UI can surface a visible signal instead of silently freezing at the last-received phase. */
  onDisconnect: (cb: () => void) => void;
}

type Connect = (info: { name: string }) => chrome.runtime.Port;

export function createPortClient(
  onUpdate: (msg: SwUpdate) => void,
  connect: Connect = (info) => chrome.runtime.connect(info),
): PortClient {
  let port: chrome.runtime.Port | null = null;
  let onDisconnectCb: (() => void) | null = null;

  function open(): chrome.runtime.Port {
    const p = connect({ name: PORT_NAME });
    port = p;
    p.onMessage.addListener((msg) => onUpdate(msg as SwUpdate));
    p.onDisconnect.addListener(() => {
      void chrome.runtime?.lastError; // swallow the expected "port disconnected" notice
      onDisconnectCb?.();
      if (port === p) port = null; // next send() revives it (and wakes the SW)
    });
    return p;
  }

  return {
    send(cmd) {
      const p = port ?? open();
      try {
        p.postMessage(cmd);
      } catch {
        // Died between the null-check and the post — reconnect once and retry.
        port = null;
        open().postMessage(cmd);
      }
    },
    disconnect() {
      try {
        port?.disconnect();
      } catch {
        /* noop */
      }
      port = null;
    },
    onDisconnect(cb) {
      onDisconnectCb = cb;
    },
  };
}
