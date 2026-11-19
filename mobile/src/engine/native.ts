import { Capacitor } from '@capacitor/core';
import type {
  BackupEngine,
  BackupStatus,
  DiscoveredPc,
  EngineSettings,
  EngineSettingsUpdate,
  HashedPhoto,
  PairingPayload,
  PairedPc,
  PhonePhoto,
  TimelinePage,
  UploadOptions,
  UploadResult,
} from './types';

const NOT_READY =
  'The native backup engine is not wired into the app yet. Use the diagnostics panel to run the native spike checks.';

function nativeNotReady(): Promise<never> {
  return Promise.reject(new Error(NOT_READY));
}

class NativeEngine implements BackupEngine {
  readonly mode = 'native' as const;
  private settings: EngineSettings = {
    wifiOnly: true,
    chargingOnly: false,
    autoBackup: true,
  };

  scanPhotos(): Promise<PhonePhoto[]> {
    return nativeNotReady();
  }

  hashPhotos(_photos: readonly PhonePhoto[]): Promise<HashedPhoto[]> {
    return nativeNotReady();
  }

  checkMissing(_hashes: readonly string[]): Promise<string[]> {
    return nativeNotReady();
  }

  upload(_photo: HashedPhoto, _options?: UploadOptions): Promise<UploadResult> {
    return nativeNotReady();
  }

  async status(): Promise<BackupStatus> {
    return {
      phase: 'idle',
      connection: 'not_paired',
      pairedPc: null,
      phonePhotos: 0,
      backedUp: 0,
      pending: 0,
      failed: 0,
      totalBytes: 0,
      uploadedBytes: 0,
      currentPhoto: null,
      lastBackupAt: null,
      message: 'Pair once with your PC to start backup',
      updatedAt: new Date().toISOString(),
    };
  }

  pairWithQr(_payload: PairingPayload | string): Promise<PairedPc> {
    return nativeNotReady();
  }

  discoverPc(_timeoutMs?: number): Promise<DiscoveredPc[]> {
    return nativeNotReady();
  }

  async getSettings(): Promise<EngineSettings> {
    return { ...this.settings };
  }

  async setSettings(update: EngineSettingsUpdate): Promise<EngineSettings> {
    this.settings = { ...this.settings, ...update };
    return { ...this.settings };
  }

  fetchTimeline(_cursor?: string | null, _limit?: number): Promise<TimelinePage> {
    return nativeNotReady();
  }

  subscribe(_listener: (status: BackupStatus) => void): () => void {
    return () => {};
  }
}

export function createNativeEngine(): BackupEngine {
  return new NativeEngine();
}

export function isNativePlatform(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}
