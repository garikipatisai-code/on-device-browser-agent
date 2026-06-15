import type { ManifestV3Export } from '@crxjs/vite-plugin';

export const manifest: ManifestV3Export = {
  manifest_version: 3,
  name: 'Browser Agent',
  description: 'Goal-anchored autonomous browser agent (local-first, MV3).',
  version: '0.1.0',
  minimum_chrome_version: '116',
  action: {
    default_title: 'Open Browser Agent',
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
  ],
  host_permissions: ['<all_urls>'],
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
