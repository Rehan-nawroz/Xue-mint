import type { GalleryAsset } from '@xue-mint/shared';
import type {
  GalleryApi,
  ConnectionStatus,
  LibraryStatus,
  PairedDevice,
  PairingInfo,
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

export const defaultPairing: PairingInfo = {
  version: 1,
  serverName: 'STUDIO-PC',
  addresses: ['192.168.1.24'],
  port: 8427,
  fingerprint:
    '4B:1E:9C:2A:77:0D:31:8F:6E:52:A0:CD:19:44:B8:7E:' +
    '23:91:0F:5A:C7:64:D2:88:3B:EE:15:6D:9A:40:52:FC',
  token: 'XM7K-4QDP',
  expiresAt: '2030-01-01T00:10:00.000Z',
};

export const defaultConnection: ConnectionStatus = {
  allowed: false,
  canManage: true,
  platform: 'windows',
  port: 8427,
  addresses: ['192.168.1.24'],
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
    deleteAsset: async () => undefined,
    renameAsset: async (_id, filename) => filename,
    fetchSettings: async () => defaultSettings,
    createPairingCode: async () => defaultPairing,
    fetchConnection: async () => defaultConnection,
    setConnection: async (allowed) => ({ ...defaultConnection, allowed }),
    factoryReset: async () => ({ filesRemoved: 0 }),
    importFiles: async () => ({ imported: 0, duplicates: 0 }),
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
