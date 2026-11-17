import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  // Brand assets are imported from the single brand folder, never copied per app.
  publicDir: false,
  build: {
    outDir: 'dist',
    // Keep hashed app assets out of /assets, which is the server's API namespace.
    assetsDir: 'static',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
    // Local development against the real server, whose certificate is self-signed.
    proxy: Object.fromEntries(
      ['/pair', '/assets', '/devices', '/local'].map((path) => [
        path,
        {
          target: process.env.XM_SERVER_URL ?? 'https://127.0.0.1:8443',
          secure: false,
        },
      ])
    ),
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
});
