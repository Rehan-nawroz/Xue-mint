import { Capacitor } from '@capacitor/core';
import {
  nativeBackupState,
  nativeBackupWorkStatus,
  nativeDeleteAsset,
  nativeDeviceStatus,
  nativeDiscoverPc,
  nativeEnginePhotos,
  nativeEngineSettings,
  nativeDownloadAsset,
  nativeFactoryReset,
  nativeMediaServer,
  nativeOpenBatterySettings,
  nativePairPc,
  nativePairingState,
  nativeRequestBatteryExemption,
  nativeRequestNotificationPermission,
  nativeSaveEngineSettings,
  nativeScheduleBackupWork,
  nativeStartBackup,
  nativeTimeline,
} from './native-bridge';
import type { NativeEnginePhoto, NativeTimelineItem } from './native-bridge';
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
  PhonePhotoState,
  TimelinePage,
  UploadOptions,
  UploadResult,
} from './types';
import type { GalleryAsset } from '@xue-mint/shared';


const NOT_BACKED =
  'The native engine runs hashing, checking and uploading inside a backup pass. Use Start backup from the Settings screen; direct calls are not needed by the app.';

/**
 * The 127.0.0.1 media proxy address, read once. Every gallery image and
 * video loads through it, so the WebView never needs the device credential.
 */
let mediaBasePromise: Promise<string> | null = null;

function mediaBase(): Promise<string> {
  mediaBasePromise ??= nativeMediaServer();
  return mediaBasePromise;
}

function assetFromItem(item: NativeTimelineItem, base: string): GalleryAsset {
  const filename = item.filename ?? null;
  return {
    id: item.id,
    type: item.type === 'video' ? 'video' : 'photo',
    filename,
    takenAt: item.takenAt ?? item.addedAt,
    addedAt: item.addedAt,
    width: item.width,
    height: item.height,
    size: item.size,
    thumbUrl: `${base}/pc/thumb/${item.id}`,
    originalUrl: `${base}/pc/original/${item.id}?name=${encodeURIComponent(filename ?? '')}`,
  } as GalleryAsset;
}

/** The phone library as gallery tiles the shared grid can render. */
export function phoneGalleryAsset(state: PhonePhotoState, base: string): GalleryAsset {
  const photo = state.photo;
  return {
    id: `phone-${photo.id}`,
    type: 'photo',
    filename: photo.filename,
    takenAt: photo.takenAt,
    addedAt: photo.takenAt,
    width: photo.width,
    height: photo.height,
    size: photo.size,
    thumbUrl: `${base}/phone/thumb/${photo.id}`,
    originalUrl: `${base}/phone/original/${photo.id}?name=${encodeURIComponent(photo.filename)}`,
  } as GalleryAsset;
}

/** Full connection check (pinned TLS round trip) while idle. */
const FULL_POLL_MS = 20_000;

/** Cheap engine-only poll while a backup pass is running. */
const ACTIVE_POLL_MS = 2_000;

class NativeEngine implements BackupEngine {
  readonly mode = 'native' as const;
  private listeners = new Set<(status: BackupStatus) => void>();
  private pollTimer: number | null = null;
  private lastStatus: BackupStatus | null = null;
  private lastFullCheck = 0;
  private fullChecking: Promise<BackupStatus> | null = null;

  async scanPhotos(): Promise<PhonePhoto[]> {
    const result = await nativeEnginePhotos(1000);
    return result.photos.map((photo) => toPhonePhoto(photo));
  }

  hashPhotos(_photos: readonly PhonePhoto[]): Promise<HashedPhoto[]> {
    return Promise.reject(new Error(NOT_BACKED));
  }

  checkMissing(_hashes: readonly string[]): Promise<string[]> {
    return Promise.reject(new Error(NOT_BACKED));
  }

  upload(_photo: HashedPhoto, _options?: UploadOptions): Promise<UploadResult> {
    return Promise.reject(new Error(NOT_BACKED));
  }

  /** Full status: pairing check over pinned TLS plus the engine counters. */
  async status(): Promise<BackupStatus> {
    if (this.fullChecking) return this.fullChecking;

    this.fullChecking = (async () => {
      try {
        const state = await nativePairingState();
        const status = buildStatus(
          state.connection,
          state.message,
          state.pc,
          state.backup ?? null
        );
        this.lastStatus = status;
        this.lastFullCheck = Date.now();
        return status;
      } catch (cause) {
        const status = buildStatus(
          'error',
          cause instanceof Error ? cause.message : String(cause),
          this.lastStatus?.pairedPc ?? null,
          this.lastBackupOnly()
        );
        this.lastStatus = status;
        return status;
      } finally {
        this.fullChecking = null;
      }
    })();

    return this.fullChecking;
  }

  /**
   * Parses and validates the code, then pairs over pinned TLS. The one-time
   * token stays in memory only; the engine stores the returned credential and
   * starts its first backup pass on its own.
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

    this.lastStatus = null;
    const status = await this.status();
    this.emit(status);
    return pc;
  }

  discoverPc(timeoutMs = 6000): Promise<DiscoveredPc[]> {
    return nativeDiscoverPc(timeoutMs);
  }

  async getSettings(): Promise<EngineSettings> {
    return nativeEngineSettings();
  }

  async setSettings(update: EngineSettingsUpdate): Promise<EngineSettings> {
    const current = await nativeEngineSettings();
    const next = await nativeSaveEngineSettings({ ...current, ...update });
    return next;
  }

  fetchTimeline(cursor: string | null = null, limit = 120): Promise<TimelinePage> {
    return (async () => {
      const base = await mediaBase();
      const result = await nativeTimeline(cursor, limit);
      return {
        items: result.items.map((item) => assetFromItem(item, base)) as GalleryAsset[],
        nextCursor: result.nextCursor,
      };
    })();
  }

  /** Asks the PC to drop the asset from its library index. */
  async deleteAsset(assetId: string): Promise<void> {
    await nativeDeleteAsset(assetId);
  }

  /** Kicks a backup pass and reports where the engine stands afterwards. */
  async startBackup(): Promise<BackupStatus> {
    try {
      await nativeStartBackup();
    } catch (cause) {
      // A rejected call means the engine refused to start (Wi-Fi only rule,
      // no pairing). The message is written for the user as-is.
      const status = buildStatus(
        this.lastStatus?.connection ?? 'error',
        cause instanceof Error ? cause.message : String(cause),
        this.lastStatus?.pairedPc ?? null,
        this.lastBackupOnly()
      );
      this.lastStatus = status;
      this.emit(status);
      return status;
    }
    // Give the pass a moment to publish its first phase.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const status = await this.status();
    this.emit(status);
    return status;
  }

  async photoStates(limit = 50): Promise<PhonePhotoState[]> {
    const base = await mediaBase();
    const result = await nativeEnginePhotos(limit);
    return result.photos.map((photo) => ({
      photo: toPhonePhoto(photo),
      state: photo.state,
      hash: photo.hash,
      error: photo.lastError,
      thumbUrl: `${base}/phone/thumb/${photo.id}`,
      originalUrl: `${base}/phone/original/${photo.id}?name=${encodeURIComponent(photo.filename)}`,
    }));
  }

  /** Queues the WorkManager backup under the current backup rules. */
  async scheduleBackgroundBackup(): Promise<{
    enqueued: boolean;
    pending: number;
    workState?: string;
  }> {
    const outcome = await nativeScheduleBackupWork();
    let workState: string | undefined;
    try {
      workState = (await nativeBackupWorkStatus()).state;
    } catch {
      // The queue answer is already useful on its own.
    }
    return { ...outcome, workState };
  }

  async deviceStatus() {
    return nativeDeviceStatus();
  }

  async requestBatteryExemption(): Promise<{ granted: boolean }> {
    return { granted: await nativeRequestBatteryExemption() };
  }

  async openBatterySettings(): Promise<void> {
    await nativeOpenBatterySettings();
  }

  async requestNotificationPermission(): Promise<{ granted: boolean }> {
    return { granted: await nativeRequestNotificationPermission() };
  }

  async factoryReset(): Promise<{ pcReset?: boolean } | void> {
    return nativeFactoryReset();
  }

  async downloadAsset(asset: { id: string; filename: string | null; type: string }): Promise<void> {
    const saved = await nativeDownloadAsset({
      assetId: asset.id,
      filename: asset.filename ?? asset.id + '.jpg',
      mimeType: asset.type === 'video' ? 'video/mp4' : 'image/jpeg',
    });
    console.log('BackupEngine: saved ' + saved.filename + ' into ' + saved.savedTo);
  }

  /** Publishes state updates while the UI is open. */
  subscribe(listener: (status: BackupStatus) => void): () => void {
    this.listeners.add(listener);
    this.startPolling();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopPolling();
    };
  }

  private lastBackupOnly() {
    if (!this.lastStatus) return null;
    return {
      phase: this.lastStatus.phase,
      phonePhotos: this.lastStatus.phonePhotos,
      backedUp: this.lastStatus.backedUp,
      pending: this.lastStatus.pending,
      failed: this.lastStatus.failed,
      uploadedBytes: this.lastStatus.uploadedBytes,
      totalBytes: this.lastStatus.totalBytes,
      currentPhoto: this.lastStatus.currentPhoto,
      lastBackupAt: this.lastStatus.lastBackupAt,
      message: this.lastStatus.message,
    };
  }

  private emit(status: BackupStatus) {
    for (const listener of this.listeners) listener(status);
  }

  /**
   * Polls the engine every 2 seconds while a pass runs so progress moves, and
   * does the full pinned-TLS connection check every 20 seconds when idle.
   */
  private startPolling() {
    if (this.pollTimer !== null) return;
    this.pollTimer = window.setInterval(() => {
      if (document.hidden) return;
      void this.tick();
    }, ACTIVE_POLL_MS);
  }

  private stopPolling() {
    if (this.pollTimer === null) return;
    window.clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async tick() {
    const idle = this.lastStatus === null || this.lastStatus.phase === 'idle';
    const dueForFullCheck = Date.now() - this.lastFullCheck >= FULL_POLL_MS;

    if (idle && dueForFullCheck) {
      const status = await this.status();
      this.emit(status);
      return;
    }

    // While a pass runs, publish engine-only progress without touching TLS.
    try {
      const backup = await nativeBackupState();
      if (backup.phase === 'idle' && idle) return;
      const status = buildStatus(
        this.lastStatus?.connection ?? 'searching',
        backup.message,
        this.lastStatus?.pairedPc ?? null,
        backup
      );
      this.lastStatus = status;
      this.emit(status);
    } catch {
      // The next full check reports the reason.
    }
  }
}

function toPhonePhoto(photo: NativeEnginePhoto): PhonePhoto {
  return {
    id: photo.id,
    uri: photo.uri,
    filename: photo.filename,
    mimeType: photo.mimeType,
    size: photo.size,
    takenAt: photo.takenAt,
    width: photo.width,
    height: photo.height,
  };
}

/**
 * Merges the connection answer and the engine counters into the one status
 * object the UI renders, with the human-readable line the status bar shows.
 */
function buildStatus(
  connection: BackupStatus['connection'],
  connectionMessage: string,
  pc: PairedPc | null,
  backup: {
    phase: BackupStatus['phase'];
    phonePhotos: number;
    backedUp: number;
    pending: number;
    failed: number;
    uploadedBytes: number;
    totalBytes: number;
    currentPhoto: string | null;
    lastBackupAt: string | null;
    message: string;
  } | null
): BackupStatus {
  const phase = backup?.phase ?? 'idle';
  const pending = backup?.pending ?? 0;
  const failed = backup?.failed ?? 0;
  const currentPhoto = backup?.currentPhoto ?? null;

  let message = connectionMessage;
  if (connection === 'not_paired') {
    message = 'Pair once with your PC to start backup';
  } else if (connection === 'unreachable') {
    message = "PC not reachable — will back up when you're home";
  } else if (connection === 'error' && !backup?.message) {
    message = connectionMessage;
  } else if (backup) {
    message = backup.message;
  } else if (connection === 'blocked') {
    message = connectionMessage;
  }

  if (connection === 'connected' && phase === 'idle' && pending > 0 && !currentPhoto) {
    message = `${pending} ${pending === 1 ? 'photo' : 'photos'} waiting to back up`;
  } else if (connection === 'connected' && phase === 'idle' && pending === 0 && failed === 0) {
    message = 'All photos are on your PC';
  }

  return {
    phase,
    connection,
    pairedPc: pc,
    phonePhotos: backup?.phonePhotos ?? 0,
    backedUp: backup?.backedUp ?? 0,
    pending,
    failed,
    totalBytes: backup?.totalBytes ?? 0,
    uploadedBytes: backup?.uploadedBytes ?? 0,
    currentPhoto,
    lastBackupAt: backup?.lastBackupAt ?? null,
    message,
    updatedAt: new Date().toISOString(),
  };
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
