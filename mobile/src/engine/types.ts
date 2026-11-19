import type { GalleryAsset } from '@xue-mint/shared';

/** Which implementation is currently serving the UI. */
export type EngineMode = 'mock' | 'native';

/** A photo as the phone's media library exposes it. */
export interface PhonePhoto {
  id: string;
  /** Platform URI; the native engine reads bytes from it. */
  uri: string;
  filename: string;
  mimeType: string;
  size: number;
  /** ISO timestamp of capture, or of the file when capture time is unknown. */
  takenAt: string;
  width: number | null;
  height: number | null;
}

export interface HashedPhoto {
  photo: PhonePhoto;
  /** BLAKE3 digest, lower-case hex. */
  hash: string;
}

export interface UploadProgress {
  sentBytes: number;
  totalBytes: number;
}

export interface UploadOptions {
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}

export interface UploadResult {
  hash: string;
  status: 'uploaded' | 'duplicate';
}

/** Payload carried by the desktop pairing QR code. */
export interface PairingPayload {
  version: number;
  serverName: string;
  addresses: string[];
  port: number;
  fingerprint: string;
  token: string | null;
  expiresAt: string | null;
}

export interface PairedPc {
  name: string;
  addresses: string[];
  port: number;
  fingerprint: string;
  pairedAt: string;
}

export interface DiscoveredPc {
  /** mDNS instance name. */
  name: string;
  addresses: string[];
  port: number;
  fingerprint: string | null;
  version: string | null;
}

export type ConnectionState =
  | 'connected'
  | 'searching'
  | 'unreachable'
  | 'not_paired'
  | 'error';

export type BackupPhase =
  | 'idle'
  | 'scanning'
  | 'hashing'
  | 'checking'
  | 'uploading'
  | 'paused'
  | 'error';

/** Everything the UI needs to display, produced only by the engine. */
export interface BackupStatus {
  phase: BackupPhase;
  connection: ConnectionState;
  pairedPc: PairedPc | null;
  phonePhotos: number;
  backedUp: number;
  pending: number;
  failed: number;
  totalBytes: number;
  uploadedBytes: number;
  currentPhoto: string | null;
  lastBackupAt: string | null;
  /** Short, human-readable line for the status bar. */
  message: string;
  updatedAt: string;
}

export interface EngineSettings {
  /** Back up over any network, not just the home Wi-Fi. */
  wifiOnly: boolean;
  /** Only back up while the phone is charging. */
  chargingOnly: boolean;
  /** Run automatic backup at all. */
  autoBackup: boolean;
}

export type EngineSettingsUpdate = Partial<EngineSettings>;

export interface TimelinePage {
  items: GalleryAsset[];
  nextCursor: string | null;
}

/**
 * The single boundary between the React UI and all backup work.
 *
 * The browser mock and the native Capacitor/Kotlin engine both implement this
 * interface. The UI calls these methods and renders the results; it never reads
 * the media library, hashes files or talks to the desktop itself.
 */
export interface BackupEngine {
  readonly mode: EngineMode;

  /** Lists photos in the phone library, newest first. */
  scanPhotos(): Promise<PhonePhoto[]>;

  /** Hashes photos once; implementations may reuse remembered digests. */
  hashPhotos(photos: readonly PhonePhoto[]): Promise<HashedPhoto[]>;

  /** Returns the subset of hashes that the paired PC does not have. */
  checkMissing(hashes: readonly string[]): Promise<string[]>;

  /** Uploads one photo, resuming from any recorded partial offset. */
  upload(photo: HashedPhoto, options?: UploadOptions): Promise<UploadResult>;

  /** Current backup and connection state. */
  status(): Promise<BackupStatus>;

  /**
   * Pairs with the PC whose QR payload is supplied. Accepts either the parsed
   * object or the raw JSON string scanned from the QR code.
   */
  pairWithQr(payload: PairingPayload | string): Promise<PairedPc>;

  /** Finds the desktop on the local network using mDNS. */
  discoverPc(timeoutMs?: number): Promise<DiscoveredPc[]>;

  getSettings(): Promise<EngineSettings>;

  setSettings(update: EngineSettingsUpdate): Promise<EngineSettings>;

  /** Reads a page of the PC library timeline, newest first. */
  fetchTimeline(cursor?: string | null, limit?: number): Promise<TimelinePage>;

  /** Subscribes to status changes caused by engine work. */
  subscribe(listener: (status: BackupStatus) => void): () => void;
}

export interface MediaScanSample {
  id: string;
  filename: string;
  takenAt: string;
  size: number;
  mimeType: string;
}

export interface MediaScanResult {
  count: number;
  photos: MediaScanSample[];
  permission: 'granted' | 'denied';
}

export interface TlsProbeResult {
  ok: boolean;
  message: string;
  httpStatus: number | null;
  certificateFingerprint: string | null;
}

export interface WorkProbeStatus {
  state: string;
  message: string | null;
}

/**
 * Native-only checks used to de-risk the Android engine on a real device.
 * Kept apart from BackupEngine so the normal app never depends on spike code.
 */
export interface NativeDiagnostics {
  ping(): Promise<{ message: string; sdk: number }>;
  requestMediaPermission(): Promise<boolean>;
  scanMediaStore(limit?: number): Promise<MediaScanResult>;
  discoverPc(timeoutMs?: number): Promise<DiscoveredPc[]>;
  probeTls(address: string, port: number, fingerprint: string): Promise<TlsProbeResult>;
  scheduleWorkProbe(): Promise<{ workId: string }>;
  workProbeStatus(): Promise<WorkProbeStatus>;
}
