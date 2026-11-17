import type { GalleryAsset } from '@xue-mint/shared';
import type {
  GalleryApi,
  LibraryStatus,
  PairedDevice,
  ServerSettings,
} from '../api/types';

export function makeAsset(
  overrides: Partial<GalleryAsset> & Pick<GalleryAsset, 'id'>
): GalleryAsset {
  return {
    type: 'photo',
    filename: `${overrides.id}.jpg`,
    takenAt: '2024-01-15T10:00:00',
    addedAt: '2024-01-15T10:00:00',
    width: 1000,
    height: 800,
    size: 1000,
    thumbUrl: `/assets/${overrides.id}/thumb`,
    originalUrl: `/assets/${overrides.id}/original`,
    ...overrides,
  };
}

export function makeAssets(count: number, startDay = 15): GalleryAsset[] {
  return Array.from({ length: count }, (_, index) => {
    const day = startDay + Math.floor(index / 8);
    const hour = 20 - (index % 8);
    const iso = `2024-01-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00`;
    return makeAsset({
      id: `asset-${String(index).padStart(4, '0')}`,
      takenAt: iso,
      addedAt: iso,
      filename: `IMG_${index}.jpg`,
      type: index % 10 === 3 ? 'video' : 'photo',
    });
  });
}

export const defaultStatus: LibraryStatus = {
  assetCount: 2,
  photoCount: 1,
  videoCount: 1,
  totalBytes: 2048,
  deviceCount: 1,
  activeUploads: 0,
  lastActivityAt: '2024-01-15T10:00:00',
  lastDeviceSeenAt: '2024-01-15T09:00:00',
};

export const defaultSettings: ServerSettings = {
  deleteBehavior: 'index_only',
  photosFolder: 'C:\\Photos',
  port: 8427,
  activePhotosFolder: 'C:\\Photos',
  activePort: 8427,
  restartRequired: false,
};

export function makeDevice(overrides: Partial<PairedDevice> = {}): PairedDevice {
  return {
    id: 'device-1',
    name: 'Pixel 8',
    pairedAt: '2024-01-01T10:00:00',
    lastSeenAt: '2024-01-15T09:00:00',
    revoked: false,
    ...overrides,
  };
}

/** Complete API stub; every method can be overridden per test. */
export function makeApi(overrides: Partial<GalleryApi> = {}): GalleryApi {
  return {
    mode: 'mock',
    ensureSession: async () => undefined,
    fetchTimeline: async () => ({ items: [], nextCursor: null }),
    fetchStatus: async () => defaultStatus,
    fetchDevices: async () => [],
    revokeDevice: async () => undefined,
    fetchSettings: async () => defaultSettings,
    saveSettings: async (update) => ({
      ...defaultSettings,
      ...update,
      deleteBehavior: update.deleteBehavior ?? defaultSettings.deleteBehavior,
      photosFolder: update.photosFolder ?? defaultSettings.photosFolder,
      port: update.port ?? defaultSettings.port,
    }),
    ...overrides,
  };
}
