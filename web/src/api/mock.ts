import type { GalleryAsset } from '@xue-mint/shared';
import type {
  DeleteBehavior,
  GalleryApi,
  ConnectionStatus,
  LibraryStatus,
  PairedDevice,
  PairingInfo,
  ServerSettings,
  SettingsUpdate,
  TimelinePage,
} from './types';
import { GalleryApiError } from './types';

interface MockOptions {
  count?: number;
  latencyMs?: number;
  empty?: boolean;
  now?: Date;
}

function svgTile(label: string, hueSeed: number, big = false): string {
  const size = big ? 1200 : 320;
  const hue = hueSeed % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 28% 62%)"/>
      <stop offset="1" stop-color="hsl(${(hue + 48) % 360} 22% 32%)"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="url(#g)"/>
  <circle cx="${size * 0.7}" cy="${size * 0.3}" r="${size * 0.12}" fill="rgba(255,255,255,0.35)"/>
  <text x="50%" y="54%" text-anchor="middle" font-family="system-ui, sans-serif"
        font-size="${big ? 64 : 28}" fill="rgba(255,255,255,0.85)">${label}</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function buildAssets(count: number, now: Date): GalleryAsset[] {
  const assets: GalleryAsset[] = [];
  for (let i = 0; i < count; i += 1) {
    const date = new Date(now);
    date.setDate(now.getDate() - Math.floor(i / 8));
    date.setHours(18 - (i % 8), 12, 0, 0);
    const isVideoItem = i % 11 === 5;
    const id = `mock-${String(i).padStart(5, '0')}`;
    assets.push({
      id,
      type: isVideoItem ? 'video' : 'photo',
      filename: `${isVideoItem ? 'clip' : 'IMG'}_${String(1000 + i)}.${isVideoItem ? 'mp4' : 'jpg'}`,
      takenAt: date.toISOString(),
      addedAt: date.toISOString(),
      width: 4032,
      height: 3024,
      size: isVideoItem ? 24_000_000 + i * 1000 : 2_400_000 + i * 500,
      thumbUrl: svgTile(isVideoItem ? '▶' : String(i + 1), i * 23),
      originalUrl: svgTile(isVideoItem ? 'Video preview' : `Photo ${i + 1}`, i * 23, true),
    });
  }
  return assets;
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/**
 * Browser-only gallery backed by generated assets. Used for UI work and tests
 * without a running server; it never talks to the network.
 */
export function createMockApi(options: MockOptions = {}): GalleryApi {
  const now = options.now ?? new Date();
  const latencyMs = options.latencyMs ?? 120;
  let assets = options.empty ? [] : buildAssets(options.count ?? 240, now);
  const revoked = new Set<string>();
  let connectionAllowed = false;
  const connectionStatus = (): ConnectionStatus => ({
    allowed: connectionAllowed,
    canManage: true,
    platform: 'windows',
    port: settings.activePort,
    addresses: ['192.168.1.24'],
  });
  let settings: ServerSettings = {
    deleteBehavior: 'index_only',
    photosFolder: 'C:\\Users\\You\\Pictures\\XueMint',
    mirrorFolder: '',
    mirrorAvailable: true,
    port: 8427,
    activePhotosFolder: 'C:\\Users\\You\\Pictures\\XueMint',
    activePort: 8427,
    restartRequired: false,
  };
  const devices: PairedDevice[] = [
    {
      id: 'mock-phone',
      name: 'Pixel 8',
      pairedAt: new Date(now.getTime() - 6 * 86400000).toISOString(),
      lastSeenAt: new Date(now.getTime() - 3600_000).toISOString(),
      revoked: false,
    },
    {
      id: 'mock-tablet',
      name: 'Android tablet',
      pairedAt: new Date(now.getTime() - 21 * 86400000).toISOString(),
      lastSeenAt: new Date(now.getTime() - 4 * 86400000).toISOString(),
      revoked: false,
    },
  ];

  return {
    mode: 'mock',

    async ensureSession() {
      await delay(latencyMs);
    },

    async fetchTimeline(cursor = null, limit = 200, query = ''): Promise<TimelinePage> {
      await delay(latencyMs);
      const offset = cursor ? Number.parseInt(cursor, 10) || 0 : 0;
      const pageSize = Math.max(1, Math.min(limit, 500));
      const term = query.trim().toLowerCase();
      const matches = term
        ? assets.filter((asset) => (asset.filename ?? '').toLowerCase().includes(term))
        : assets;
      const items = matches.slice(offset, offset + pageSize);
      const next = offset + items.length;
      return {
        items,
        nextCursor: next < matches.length ? String(next) : null,
      };
    },

    async fetchStatus(): Promise<LibraryStatus> {
      await delay(latencyMs);
      const photos = assets.filter((asset) => asset.type === 'photo');
      const videos = assets.filter((asset) => asset.type === 'video');
      return {
        assetCount: assets.length,
        photoCount: photos.length,
        videoCount: videos.length,
        totalBytes: assets.reduce((total, asset) => total + (asset.size ?? 0), 0),
        deviceCount: devices.filter((device) => !device.revoked).length,
        activeUploads: 0,
        lastActivityAt: assets[0]?.addedAt ?? null,
        lastDeviceSeenAt: devices[0]?.lastSeenAt ?? null,
      };
    },

    async fetchDevices(): Promise<PairedDevice[]> {
      await delay(latencyMs);
      return devices.map((device) => ({ ...device, revoked: revoked.has(device.id) }));
    },

    async revokeDevice(id: string) {
      await delay(latencyMs);
      if (!devices.some((device) => device.id === id)) {
        throw new GalleryApiError(404, 'DEVICE_NOT_FOUND', 'No such device.');
      }
      revoked.add(id);
    },

    async deleteAsset(id: string) {
      await delay(latencyMs);
      const index = assets.findIndex((asset) => asset.id === id);
      if (index < 0) throw new GalleryApiError(404, 'ASSET_NOT_FOUND', 'No such asset.');
      assets = [...assets.slice(0, index), ...assets.slice(index + 1)];
    },

    async renameAsset(id: string, filename: string) {
      await delay(latencyMs);
      const asset = assets.find((entry) => entry.id === id);
      if (!asset) throw new GalleryApiError(404, 'ASSET_NOT_FOUND', 'No such asset.');
      const next = filename.trim();
      if (!next) throw new GalleryApiError(400, 'BAD_REQUEST', 'Enter a file name.');
      asset.filename = next;
      return next;
    },

    async fetchSettings(): Promise<ServerSettings> {
      await delay(latencyMs);
      return { ...settings };
    },

    async fetchConnection(): Promise<ConnectionStatus> {
      await delay(latencyMs);
      return connectionStatus();
    },

    async setConnection(allowed: boolean): Promise<ConnectionStatus> {
      await delay(latencyMs);
      connectionAllowed = allowed;
      return connectionStatus();
    },

    async importFiles(files: File[]) {
      await delay(latencyMs * 2);
      const now = new Date().toISOString();
      for (const file of files) {
        assets = [
          {
            id: `imported-${now}-${file.name}`,
            thumbUrl: svgTile(file.name.slice(0, 4), 7),
            originalUrl: svgTile(file.name, 7, true),
            type: 'photo',
            filename: file.name,
            takenAt: now,
            addedAt: now,
            width: null,
            height: null,
            size: file.size,
          },
          ...assets,
        ];
      }
      return { imported: files.length, duplicates: 0 };
    },
    async factoryReset(options?: { deleteFiles?: boolean }) {
      await delay(latencyMs);
      // The mock drops its sample library and reports the removed files.
      const removed = assets.length;
      assets = [];
      return { filesRemoved: options?.deleteFiles ? removed : 0 };
    },

    async createPairingCode(): Promise<PairingInfo> {
      await delay(latencyMs);
      return {
        version: 1,
        serverName: 'STUDIO-PC',
        addresses: ['192.168.1.24'],
        port: settings.activePort,
        fingerprint:
          '4B:1E:9C:2A:77:0D:31:8F:6E:52:A0:CD:19:44:B8:7E:' +
          '23:91:0F:5A:C7:64:D2:88:3B:EE:15:6D:9A:40:52:FC',
        token: 'XM7K-4QDP',
        expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
      };
    },

    async saveSettings(update: SettingsUpdate): Promise<ServerSettings> {
      await delay(latencyMs);
      if (update.port !== undefined && (update.port < 1024 || update.port > 65535)) {
        throw new GalleryApiError(400, 'BAD_REQUEST', 'Choose a port between 1024 and 65535.');
      }
      if (update.deleteBehavior !== undefined) {
        const behavior: DeleteBehavior = update.deleteBehavior;
        settings = { ...settings, deleteBehavior: behavior };
      }
      if (update.photosFolder !== undefined) {
        settings = { ...settings, photosFolder: update.photosFolder };
      }
      if (update.mirrorFolder !== undefined) {
        settings = {
          ...settings,
          mirrorFolder: update.mirrorFolder,
          mirrorAvailable: true,
        };
      }
      if (update.port !== undefined) {
        settings = { ...settings, port: update.port };
      }
      settings = {
        ...settings,
        restartRequired:
          settings.photosFolder !== settings.activePhotosFolder ||
          settings.port !== settings.activePort,
      };
      return { ...settings };
    },
  };
}
