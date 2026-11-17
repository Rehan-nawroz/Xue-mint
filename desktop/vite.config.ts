import { defineConfig } from 'vite';

export default defineConfig({
  // The brand folder is imported directly; nothing is copied per app.
  publicDir: false,
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'chrome105',
  },
});
