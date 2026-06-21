import type { ManifestV3Export } from '@crxjs/vite-plugin';

export const manifest: ManifestV3Export = {
  manifest_version: 3,
  name: 'On-Device Browser Agent',
  description: 'A goal-anchored browser agent that runs entirely on your device via a local Ollama model. MV3.',
  version: '0.1.0',
  minimum_chrome_version: '116',
  action: {
    default_title: 'Open On-Device Browser Agent',
  },
  side_panel: {
    default_path: 'src/sidepanel/index.html',
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  permissions: [
    'sidePanel',
    'storage',
    'tabs',
    'debugger',
    'activeTab',
    'alarms',
    'unlimitedStorage',
    'scripting',
    'declarativeNetRequest',
  ],
  host_permissions: ['<all_urls>'],
  // Ollama allows GET /api/tags from any origin but 403s POST /api/chat from a chrome-extension://
  // origin (it doesn't allowlist extensions by default). Strip the Origin header on requests to the
  // local Ollama port so it sees a no-origin request (like curl) and accepts it — no OLLAMA_ORIGINS
  // env-var setup required.
  declarative_net_request: {
    rule_resources: [{ id: 'ollama_origin', enabled: true, path: 'rules/ollama.json' }],
  },
  content_security_policy: {
    extension_pages:
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; base-uri 'self'",
  },
  icons: {
    '16': 'icons/icon-16.png',
    '32': 'icons/icon-32.png',
    '48': 'icons/icon-48.png',
    '128': 'icons/icon-128.png',
  },
  web_accessible_resources: [
    {
      resources: ['icons/*'],
      matches: ['<all_urls>'],
    },
  ],
};
