import { defineConfig } from 'vite';

export default defineConfig({
  // Relative Pfade sind Pflicht, damit die App im Capacitor-WebView läuft.
  base: './',
  server: { host: true, port: 5173 },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 },
});
