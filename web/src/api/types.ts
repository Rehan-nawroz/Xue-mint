import type { GalleryAsset } from '@xue-mint/shared';

export type DeleteBehavior = 'index_only' | 'delete_file';

export interface TimelinePage {
  items: GalleryAsset[];
  nextCursor: string | null;
}

export interface LibraryStatus {
  assetCount: number;
  photoCount: number;
  videoCount: number;
  totalBytes: number;
  deviceCount: number;
  activeUploads: number;
  lastActivityAt: string | null;
  lastDeviceSeenAt: string | null;
}

export interface PairedDevice {
  id: string;
  name: string;
  pairedAt: string;
  lastSeenAt: string | null;
  revoked: boolean;
}

export interface PairingInfo {
  version: number;
  serverName: string;
  addresses: string[];
  port: number;
  fingerprint: string;
  token: string | null;
  expiresAt: string | null;
}

export interface ServerSettings {
  deleteBehavior: DeleteBehavior;
  photosFolder: string;
  port: number;
  activePhotosFolder: string;
  activePort: number;
  restartRequired: boolean;
}

export interface SettingsUpdate {
  deleteBehavior?: DeleteBehavior;
  photosFolder?: string;
  port?: number;
}

export type ApiMode = 'server' | 'mock';

export interface GalleryApi {
  mode: ApiMode;
  /** Establishes the browser's same-origin gallery session (server mode only). */
  ensureSession(): Promise<void>;
  fetchTimeline(cursor?: string | null, limit?: number, query?: string): Promise<TimelinePage>;
  fetchStatus(): Promise<LibraryStatus>;
  fetchDevices(): Promise<PairedDevice[]>;
  revokeDevice(id: string): Promise<void>;
  deleteAsset(id: string): Promise<void>;
  renameAsset(id: string, filename: string): Promise<string>;
  fetchSettings(): Promise<ServerSettings>;
  saveSettings(update: SettingsUpdate): Promise<ServerSettings>;
  createPairingCode(): Promise<PairingInfo>;
}

export class GalleryApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'GalleryApiError';
    this.status = status;
    this.code = code;
  }
}

export function toGalleryApiError(error: unknown): GalleryApiError {
  if (error instanceof GalleryApiError) return error;
  if (error instanceof Error) return new GalleryApiError(0, 'NETWORK', error.message);
  return new GalleryApiError(0, 'NETWORK', 'The server could not be reached.');
}

export function isAuthError(error: GalleryApiError | null | undefined): boolean {
  if (!error) return false;
  return (
    error.code === 'AUTH_REQUIRED' ||
    error.code === 'DEVICE_REVOKED' ||
    error.status === 401
  );
}
