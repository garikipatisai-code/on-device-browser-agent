#!/usr/bin/env node
// One-shot setup: install deps, typecheck, tests, build.
// Trusts the OS keychain (Node 22+ --use-system-ca) so corporate-CA TLS
// works on any PC. Respects user's existing npm registry + proxy config.
//
//   Usage:  node extension/scripts/setup.js

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

// Re-exec self with --use-system-ca so https.get and child npm both trust
// the OS trust store (macOS keychain / Windows certs / Linux /etc/ssl).
const FLAG = '--use-system-ca';
if (!process.execArgv.includes(FLAG)) {
  const r = spawnSync(process.execPath, [FLAG, __filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(r.status ?? 1);
}

const env = { ...process.env };
// Pass --use-system-ca to spawned npm (npm itself is a Node script).
const existingNodeOptions = env.NODE_OPTIONS ?? '';
if (!existingNodeOptions.includes(FLAG)) {
  env.NODE_OPTIONS = (existingNodeOptions + ' ' + FLAG).trim();
}
// Quieter, faster-failing npm output.
env.npm_config_audit = 'false';
env.npm_config_fund = 'false';
env.npm_config_progress = 'false';
env.npm_config_loglevel = 'http';
env.npm_config_fetch_retry_maxtimeout = '20000';
env.npm_config_fetch_timeout = '15000';

// Ensure homebrew bin paths on PATH for fresh shells.
const PATH_KEY = process.platform === 'win32' ? 'Path' : 'PATH';
const sep = process.platform === 'win32' ? ';' : ':';
const extraPaths = process.platform === 'darwin'
  ? ['/opt/homebrew/bin', '/usr/local/bin']
  : [];
env[PATH_KEY] = [...new Set([...(env[PATH_KEY] || '').split(sep), ...extraPaths])]
  .filter(Boolean)
  .join(sep);

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(args, label) {
  console.log('\n==> ' + label);
  const r = spawnSync(npmCmd, args, { stdio: 'inherit', env, shell: false });
  if (r.error) {
    console.error('  Failed to spawn npm: ' + r.error.message);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error('  ✗ ' + label + ' failed (exit ' + r.status + ').');
    process.exit(r.status || 1);
  }
}

function quiet(args) {
  return spawnSync(npmCmd, args, { env, encoding: 'utf8' });
}

console.log('Browser Agent — setup');
console.log('  cwd:           ' + ROOT);
console.log('  node:          ' + process.version);
console.log('  NODE_OPTIONS:  ' + env.NODE_OPTIONS);

const reg = quiet(['config', 'get', 'registry']).stdout?.trim();
console.log('  registry:      ' + (reg || '(npm default)'));
const proxyDisplay = env.HTTPS_PROXY || env.HTTP_PROXY || quiet(['config', 'get', 'https-proxy']).stdout?.trim();
console.log('  proxy:         ' + (proxyDisplay && proxyDisplay !== 'null' ? proxyDisplay : '(none)'));
console.log('');

// Preflight
const v = quiet(['--version']);
if (v.status !== 0) {
  console.error('npm not on PATH. Install Node 20+ first.');
  process.exit(1);
}

// Wipe stale install artifacts so a fresh resolve happens
for (const p of [path.join(ROOT, 'node_modules'), path.join(ROOT, 'package-lock.json')]) {
  if (fs.existsSync(p)) {
    console.log('  Removing ' + path.basename(p) + '…');
    fs.rmSync(p, { recursive: true, force: true });
  }
}

run(['install'], 'Installing dependencies');
run(['run', 'typecheck'], 'TypeScript type-check');
run(['test'], 'Test suite');
run(['run', 'build'], 'Production build → dist/');

const dist = path.join(ROOT, 'dist');
console.log('\n✓ Setup complete.');
if (fs.existsSync(dist)) {
  const files = fs.readdirSync(dist);
  console.log('  dist/:  ' + dist);
  console.log('  count:  ' + files.length + ' entries');
}
console.log('');
console.log('Load extension in Chrome:');
console.log('  1. Open  chrome://extensions');
console.log('  2. Toggle "Developer mode"');
console.log('  3. Click "Load unpacked" → ' + dist);
