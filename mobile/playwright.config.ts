import { defineConfig } from '@playwright/test';

const PORT = 4174;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  timeout: 20_000,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
  },
  expect: {
    toHaveScreenshot: {
      // System font rendering differs slightly between machines; layout and
      // color changes still fail well below this ratio.
      maxDiffPixelRatio: 0.02,
      animations: 'disabled',
    },
  },
  projects: [{ name: 'android-viewport' }],
  webServer: {
    command: `npm run build && npm run preview -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    // Always build and serve the current app; a stale preview would silently
    // validate old CSS and screenshots.
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
