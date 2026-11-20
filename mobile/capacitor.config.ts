import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.xuemint.app',
  appName: 'Xue-Mint',
  webDir: 'dist',
  android: {
    // Everything user-facing is served from the bundled WebView; the backup
    // engine talks to the desktop over TLS from Kotlin, never from page
    // JavaScript. Gallery media (thumbnails, originals, videos) loads through
    // the engine's local media server on 127.0.0.1, which is a loopback
    // address, so allow it as image/video source.
    allowMixedContent: true,
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
