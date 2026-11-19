import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.xuemint.app',
  appName: 'Xue-Mint',
  webDir: 'dist',
  android: {
    // Everything is served from the bundled WebView; the backup engine talks
    // to the desktop over TLS from Kotlin, never from page JavaScript.
    allowMixedContent: false,
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
