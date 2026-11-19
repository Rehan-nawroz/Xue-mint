import { registerPlugin } from '@capacitor/core';
import type {
  NativeDiagnostics,
  DiscoveredPc,
  MediaScanResult,
  TlsProbeResult,
  WorkProbeStatus,
} from './types';

interface NativePlugin {
  ping(): Promise<{ message: string; sdk: number }>;
  requestMediaPermission(): Promise<{ granted: boolean }>;
  scanMediaStore(options: { limit: number }): Promise<MediaScanResult>;
  discoverPc(options: { timeoutMs: number }): Promise<{ services: DiscoveredPc[] }>;
  probeTls(options: {
    address: string;
    port: number;
    fingerprint: string;
  }): Promise<TlsProbeResult>;
  scheduleWorkProbe(): Promise<{ workId: string }>;
  workProbeStatus(): Promise<WorkProbeStatus>;
}

const native = registerPlugin<NativePlugin>('BackupEngine');

/**
 * Thin bridge to the Kotlin engine. Only the diagnostic spike calls are
 * implemented in the Android plugin at this stage; backup methods fail with a
 * clear message instead of silently pretending to work.
 */
export function createNativeDiagnostics(): NativeDiagnostics {
  return {
    async ping() {
      return native.ping();
    },
    async requestMediaPermission() {
      const result = await native.requestMediaPermission();
      return result.granted;
    },
    async scanMediaStore(limit = 25) {
      return native.scanMediaStore({ limit });
    },
    async discoverPc(timeoutMs = 6000) {
      const result = await native.discoverPc({ timeoutMs });
      return result.services;
    },
    async probeTls(address, port, fingerprint) {
      return native.probeTls({ address, port, fingerprint });
    },
    async scheduleWorkProbe() {
      return native.scheduleWorkProbe();
    },
    async workProbeStatus() {
      return native.workProbeStatus();
    },
  };
}
