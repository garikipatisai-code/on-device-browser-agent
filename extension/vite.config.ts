import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import { manifest } from './src/manifest';
import path from 'node:path';

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  // A build stamp shown in the panel header so it's obvious whether a fresh build is loaded
  // (reloading the unpacked extension is easy to forget). Build-time only.
  define: {
    __BUILD__: JSON.stringify(new Date().toISOString().slice(5, 16).replace('T', ' ')),
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  build: {
    target: 'esnext',
    sourcemap: true,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        chunkFileNames: 'assets/chunk-[hash].js',
      },
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
  },
});
