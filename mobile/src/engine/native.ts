import { Capacitor } from '@capacitor/core';
import { nativeDiscoverPc, nativePairPc, nativePairingState } from './native-bridge';
import { parsePairingPayload } from './pairing';
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

const CONNECTION_POLL_MS = 20_000;

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
  private listeners = new Set<(status: BackupStatus) => void>();
  private pollTimer: number | null = null;
  private lastStatus: BackupStatus | null = null;
  private checking: Promise<BackupStatus> | null = null;

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

  /** Reads the stored pairing and checks whether the PC answers right now. */
  async status(): Promise<BackupStatus> {
    if (this.checking) return this.checking;

    this.checking = (async () => {
      try {
        const state = await nativePairingState();
        const status = this.buildStatus(state.connection, state.message, state.pc);
        this.lastStatus = status;
        return status;
      } catch (cause) {
        const status = this.buildStatus(
          'error',
          cause instanceof Error ? cause.message : String(cause),
          this.lastStatus?.pairedPc ?? null
        );
        this.lastStatus = status;
        return status;
      } finally {
        this.checking = null;
      }
    })();

    return this.checking;
  }

  /**
   * Parses and validates the code, then pairs over pinned TLS. The one-time
   * token stays in memory only; the engine stores the returned credential.
   */
  async pairWithQr(payload: PairingPayload | string): Promise<PairedPc> {
    const parsed = typeof payload === 'string' ? parsePairingPayload(payload) : payload;
    if (!parsed.token) throw new Error('This is not a pairing code.');

    const pc = await nativePairPc({
      addresses: parsed.addresses,
      port: parsed.port,
      fingerprint: parsed.fingerprint,
      token: parsed.token,
      serverName: parsed.serverName,
    });

    this.lastStatus = this.buildStatus('connected', `Connected to ${pc.name}`, pc);
    this.emit(this.lastStatus);
    return pc;
  }

  discoverPc(timeoutMs = 6000): Promise<DiscoveredPc[]> {
    return nativeDiscoverPc(timeoutMs);
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

  /** Publishes the initial state, then re-checks the PC while the UI is open. */
  subscribe(listener: (status: BackupStatus) => void): () => void {
    this.listeners.add(listener);
    this.startPolling();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopPolling();
    };
  }

  private buildStatus(
    connection: BackupStatus['connection'],
    message: string,
    pc: PairedPc | null
  ): BackupStatus {
    return {
      phase: 'idle',
      connection,
      pairedPc: pc,
      phonePhotos: 0,
      backedUp: 0,
      pending: 0,
      failed: 0,
      totalBytes: 0,
      uploadedBytes: 0,
      currentPhoto: null,
      lastBackupAt: null,
      message,
      updatedAt: new Date().toISOString(),
    };
  }

  private emit(status: BackupStatus) {
    for (const listener of this.listeners) listener(status);
  }

  private startPolling() {
    if (this.pollTimer !== null) return;
    this.pollTimer = window.setInterval(() => {
      if (document.hidden) return;
      void this.status().then((status) => this.emit(status));
    }, CONNECTION_POLL_MS);
  }

  private stopPolling() {
    if (this.pollTimer === null) return;
    window.clearInterval(this.pollTimer);
    this.pollTimer = null;
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
