import { registerPlugin } from '@capacitor/core';
import type {
  BackupPhase,
  ConnectionState,
  DiscoveredPc,
  EngineSettings,
  PairedPc,
  PhotoBackupState,
} from './types';

/** Reachability of the stored pairing, as reported by the Kotlin engine. */
export interface NativePairingState {
  paired: boolean;
  pc: PairedPc | null;
  connection: ConnectionState;
  message: string;
  /** Engine counters, present while paired. */
  backup?: NativeBackupState;
}

/** Backup engine counters written by the Kotlin backup pass. */
export interface NativeBackupState {
  phase: BackupPhase;
  phonePhotos: number;
  backedUp: number;
  pending: number;
  failed: number;
  uploadedBytes: number;
  totalBytes: number;
  currentPhoto: string | null;
  lastBackupAt: string | null;
  message: string;
}

/** One library photo plus its remembered backup state. */
export interface NativeEnginePhoto {
  id: string;
  uri: string;
  filename: string;
  mimeType: string;
  size: number;
  takenAt: string;
  width: number | null;
  height: number | null;
  state: PhotoBackupState;
  hash: string | null;
  uploadOffset: number;
  lastError: string | null;
}

export interface NativePairOptions {
  addresses: string[];
  port: number;
  fingerprint: string;
  token: string;
  serverName: string;
}

interface NativeEnginePlugin {
  pairPc(options: NativePairOptions): Promise<{ pc: PairedPc }>;
  pairingState(): Promise<NativePairingState>;
  forgetPc(): Promise<void>;
  discoverPc(options: { timeoutMs: number }): Promise<{ services: DiscoveredPc[] }>;
  startBackup(): Promise<{ started: boolean; message: string }>;
  backupState(): Promise<NativeBackupState>;
  scheduleBackupWork(): Promise<{ enqueued: boolean; pending: number }>;
  backupWorkStatus(): Promise<{ state: string; message: string | null }>;
  mediaServer(): Promise<{ url: string }>;
  timeline(options: {
    cursor: string | null;
    limit: number;
  }): Promise<{ items: unknown[]; nextCursor: string | null; mediaBase: string }>;
  deleteAsset(options: { assetId: string }): Promise<void>;
  enginePhotos(options: { limit: number }): Promise<{
    photos: NativeEnginePhoto[];
    counts: {
      phonePhotos: number;
      backedUp: number;
      pending: number;
      failed: number;
    };
  }>;
  engineSettings(): Promise<{ settings: EngineSettings }>;
  saveEngineSettings(options: {
    settings: EngineSettings;
  }): Promise<{ settings: EngineSettings }>;
}

const native = registerPlugin<NativeEnginePlugin>('BackupEngine');

/**
 * Thin typed wrapper over the BackupEngine plugin for the operations the app
 * uses. The UI never imports Capacitor; it only sees the engine interface.
 */
export function nativePairPc(options: NativePairOptions): Promise<PairedPc> {
  return native.pairPc(options).then((result) => result.pc);
}

export function nativePairingState(): Promise<NativePairingState> {
  return native.pairingState();
}

export function nativeForgetPc(): Promise<void> {
  return native.forgetPc();
}

export function nativeDiscoverPc(timeoutMs: number): Promise<DiscoveredPc[]> {
  return native.discoverPc({ timeoutMs }).then((result) => result.services);
}

export function nativeStartBackup(): Promise<{ started: boolean; message: string }> {
  return native.startBackup();
}

/** Cheap engine-only read used while a backup pass is running. */
export function nativeBackupState(): Promise<NativeBackupState> {
  return native.backupState();
}

export function nativeEnginePhotos(limit: number): Promise<{
  photos: NativeEnginePhoto[];
  counts: {
    phonePhotos: number;
    backedUp: number;
    pending: number;
    failed: number;
  };
}> {
  return native.enginePhotos({ limit });
}

export function nativeEngineSettings(): Promise<EngineSettings> {
  return native.engineSettings().then((result) => result.settings);
}

export function nativeSaveEngineSettings(
  settings: EngineSettings
): Promise<EngineSettings> {
  return native
    .saveEngineSettings({ settings })
    .then((result) => result.settings);
}

export function nativeScheduleBackupWork(): Promise<{
  enqueued: boolean;
  pending: number;
}> {
  return native.scheduleBackupWork();
}

export function nativeBackupWorkStatus(): Promise<{
  state: string;
  message: string | null;
}> {
  return native.backupWorkStatus();
}

/** The 127.0.0.1 media proxy the WebView loads images and videos from. */
export function nativeMediaServer(): Promise<string> {
  return native.mediaServer().then((result) => result.url);
}

/** Raw PC timeline item as the server returns it (camelCase JSON). */
export interface NativeTimelineItem {
  id: string;
  hash: string;
  filename: string | null;
  type: string;
  size: number;
  takenAt: string | null;
  width: number | null;
  height: number | null;
  addedAt: string;
}

export function nativeTimeline(
  cursor: string | null,
  limit: number
): Promise<{ items: NativeTimelineItem[]; nextCursor: string | null; mediaBase: string }> {
  return native
    .timeline({ cursor, limit })
    .then((result) => result as {
      items: NativeTimelineItem[];
      nextCursor: string | null;
      mediaBase: string;
    });
}

export function nativeDeleteAsset(assetId: string): Promise<void> {
  return native.deleteAsset({ assetId });
}
