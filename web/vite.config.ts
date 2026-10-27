import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [solid(), tailwind()],
  resolve: {
    alias: {
      '@conhost/state': fileURLToPath(new URL('../src/state', import.meta.url)),
      '@conhost/web': fileURLToPath(new URL('../src/web', import.meta.url)),
    },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:7340',
        ws: true,
        changeOrigin: true,
      },
      '/debug': { target: 'http://127.0.0.1:7340', changeOrigin: true },
      '/healthz': { target: 'http://127.0.0.1:7340', changeOrigin: true },
      '/curve': { target: 'http://127.0.0.1:7340', changeOrigin: true },
      '/files': { target: 'http://127.0.0.1:7340', changeOrigin: true },
    },
  },
});
