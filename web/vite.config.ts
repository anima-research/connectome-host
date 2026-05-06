import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [solid(), tailwind()],
  resolve: {
    alias: {
      // Share state code (AgentTreeReducer, etc.) with conhost server-side.
      // The reducer is pure TS with no Node deps; safe to import from the SPA.
      '@conhost/state': fileURLToPath(new URL('../src/state', import.meta.url)),
      '@conhost/web': fileURLToPath(new URL('../src/web', import.meta.url)),
    },
  },
  build: {
    // Match WebUiModule's default staticDir (../dist/web).
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    // Dev server proxies WS to the running conhost so `bun run dev` in web/
    // talks to a real backend. Port matches WebUiModule default.
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:7340',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
