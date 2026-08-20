import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The Studio client build.
 *
 * `outDir` points at `dist/studio/client` because that is where the mountable
 * router looks for prebuilt assets. Keeping the built SPA inside `dist/` (rather
 * than beside the router source) is what lets the published package ship the UI
 * without the source tree carrying build output.
 *
 * The `@localmind/protocol` alias imports the wire types straight from the
 * library source, so a change to an SSE event shape is a type error in the UI
 * rather than a runtime surprise.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@localmind/protocol': fileURLToPath(new URL('../src/studio/protocol.ts', import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('../dist/studio/client', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1400,
  },
  server: {
    port: 5273,
    // The dev server proxies to the API process so the browser sees one origin
    // and there is no CORS configuration to get wrong.
    proxy: {
      '/api': { target: 'http://127.0.0.1:4141', changeOrigin: true },
    },
  },
});
