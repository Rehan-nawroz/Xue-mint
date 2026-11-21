import type { GalleryAsset } from '@xue-mint/shared';
import { parsePairingPayload } from './pairing';
import type {
  BackupEngine,
  DeviceHealth,
  BackupStatus,
  EngineSettings,
  EngineSettingsUpdate,
  HashedPhoto,
  PairingPayload,
  PairedPc,
  PhonePhoto,
  PhonePhotoState,
  PhotoBackupState,
  TimelinePage,
  UploadOptions,
  UploadResult,
} from './types';

export type MockScenario = 'ready' | 'unpaired' | 'offline' | 'empty';

export interface MockEngineOptions {
  scenario?: MockScenario;
  count?: number;
  phonePhotoCount?: number;
  latencyMs?: number;
  failUploads?: boolean;
  now?: Date;
}

const DEMO_FINGERPRINT =
  '4B1E9C2A770D318F6E52A0CD1944B87E23910F5AC764D2883BEE156D9A4052FC';
const DEMO_TOKEN = 'XM7K-4QDP';

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function svgTile(label: string, hueSeed: number, big = false): string {
  const size = big ? 1200 : 320;
  const hue = hueSeed % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 34% 64%)"/>
      <stop offset="1" stop-color="hsl(${(hue + 52) % 360} 24% 30%)"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="url(#g)"/>
  <circle cx="${size * 0.72}" cy="${size * 0.26}" r="${size * 0.1}" fill="rgba(255,255,255,0.34)"/>
  <path d="M0 ${size * 0.78} L${size * 0.3} ${size * 0.5} L${size * 0.52} ${size * 0.68} L${size * 0.7} ${size * 0.54} L${size} ${size * 0.82} L${size} ${size} L0 ${size} Z" fill="rgba(12,18,24,0.22)"/>
  <text x="50%" y="54%" text-anchor="middle" font-family="system-ui, sans-serif"
        font-size="${big ? 64 : 28}" fill="rgba(255,255,255,0.87)">${label}</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function atNoon(now: Date, daysAgo: number, slot: number): Date {
  const date = new Date(now);
  date.setDate(now.getDate() - daysAgo);
  date.setHours(12 - (slot % 7), (slot * 7) % 60, 0, 0);
  return date;
}

/** Deterministic sample library used by the browser preview and tests. */
export function buildMockLibrary(count: number, now: Date): GalleryAsset[] {
  const assets: GalleryAsset[] = [];
  for (let i = 0; i < count; i += 1) {
    const date = atNoon(now, Math.floor(i / 8), i % 8);
    const video = i % 13 === 6;
    const id = `demo-${String(i).padStart(5, '0')}`;
    assets.push({
      id,
      type: video ? 'video' : 'photo',
      filename: `${video ? 'clip' : 'IMG'}_${String(4200 + i)}.${video ? 'mp4' : 'jpg'}`,
      takenAt: date.toISOString(),
      addedAt: date.toISOString(),
      width: 4032,
      height: 3024,
      size: video ? 18_000_000 + i * 1000 : 2_100_000 + i * 700,
      thumbUrl: svgTile(video ? '▶' : String(i + 1), i * 29),
      originalUrl: svgTile(video ? 'Video preview' : `Photo ${i + 1}`, i * 29, true),
    });
  }
  return assets;
}

function buildPhonePhotos(count: number, now: Date): PhonePhoto[] {
  const photos: PhonePhoto[] = [];
  for (let i = 0; i < count; i += 1) {
    const date = atNoon(now, Math.floor(i / 6), i % 6);
    photos.push({
      id: `phone-${String(i).padStart(4, '0')}`,
      uri: `content://media/external/images/media/${9000 + i}`,
      filename: `IMG_${String(8100 + i)}.jpg`,
      mimeType: 'image/jpeg',
      size: 1_800_000 + i * 900,
      takenAt: date.toISOString(),
      width: 4032,
      height: 3024,
    });
  }
  return photos;
}

function fakeHash(photo: PhonePhoto): string {
  const seed = `${photo.id}:${photo.takenAt}:${photo.size}`;
  let hash = '';
  for (let i = 0; i < 64; i += 1) {
    hash += seed.charCodeAt(i % seed.length).toString(16).padStart(2, '0').slice(-1);
  }
  return hash;
}

/**
 * Browser-only engine: generated phone photos and a simulated PC, with no
 * network access. Used for UI preview, screenshot tests and development.
 */
export function createMockEngine(options: MockEngineOptions = {}): BackupEngine {
  const now = options.now ?? new Date();
  const scenario = options.scenario ?? 'ready';
  const latencyMs = options.latencyMs ?? 90;
  const phonePhotos = buildPhonePhotos(options.phonePhotoCount ?? 60, now);
  const library = scenario === 'empty' ? [] : buildMockLibrary(options.count ?? 160, now);
  const hashes = new Map(phonePhotos.map((photo) => [photo.id, fakeHash(photo)]));
  const stored = new Set<string>();
  if (scenario !== 'offline' && scenario !== 'unpaired') {
    // Leave a small queue so the status bar has something honest to show.
    for (const photo of phonePhotos.slice(0, Math.max(0, phonePhotos.length - 12))) {
      stored.add(hashes.get(photo.id) ?? '');
    }
  }
  const listeners = new Set<(status: BackupStatus) => void>();
  let pairedPc: PairedPc | null =
    scenario === 'unpaired'
      ? null
      : {
          name: 'STUDIO-PC',
          addresses: ['192.168.1.24'],
          port: 8427,
          fingerprint: DEMO_FINGERPRINT,
          pairedAt: new Date(now.getTime() - 6 * 86_400_000).toISOString(),
        };
  let settings: EngineSettings = {
    wifiOnly: true,
    chargingOnly: false,
    autoBackup: true,
  };
  let phase: BackupStatus['phase'] = 'idle';
  let currentPhoto: string | null = null;
  let uploadedBytes = 0;
  let failedIds = new Set<string>();

  const connection = (): BackupStatus['connection'] => {
    if (!pairedPc) return 'not_paired';
    if (scenario === 'offline') return 'unreachable';
    return 'connected';
  };

  const buildStatus = (): BackupStatus => {
    const backedUp = stored.size;
    const pending = Math.max(0, phonePhotos.length - backedUp);
    const connectionState = connection();
    let message: string;
    if (connectionState === 'not_paired') {
      message = 'Pair once with your PC to start backup';
    } else if (connectionState === 'unreachable') {
      message = "PC not reachable — will back up when you're home";
    } else if (phase === 'uploading' && currentPhoto) {
      message = `Backing up ${currentPhoto}`;
    } else if (pending > 0) {
      message = `${pending} ${pending === 1 ? 'photo' : 'photos'} waiting to back up`;
    } else {
      message = 'All photos are on your PC';
    }

    return {
      phase,
      connection: connectionState,
      pairedPc,
      phonePhotos: phonePhotos.length,
      backedUp,
      pending,
      failed: 0,
      totalBytes:
        phase === 'uploading' && currentPhoto
          ? (phonePhotos.find((item) => item.filename === currentPhoto)?.size ?? 0)
          : phonePhotos.reduce((total, photo) => total + photo.size, 0),
      uploadedBytes,
      currentPhoto,
      lastBackupAt:
        backedUp > 0 ? new Date(now.getTime() - 3_600_000).toISOString() : null,
      message,
      updatedAt: new Date().toISOString(),
    };
  };

  const emit = () => {
    const status = buildStatus();
    for (const listener of listeners) listener(status);
  };

  const requirePc = (): PairedPc => {
    if (!pairedPc) throw new Error('Pair with your PC first.');
    return pairedPc;
  };

  const engine: BackupEngine = {
    mode: 'mock',

    async scanPhotos(): Promise<PhonePhoto[]> {
      await delay(latencyMs);
      return phonePhotos.map((photo) => ({ ...photo }));
    },

    async hashPhotos(photos: readonly PhonePhoto[]): Promise<HashedPhoto[]> {
      await delay(latencyMs);
      phase = 'hashing';
      emit();
      const result = photos.map((photo) => ({
        photo,
        hash: hashes.get(photo.id) ?? fakeHash(photo),
      }));
      phase = 'idle';
      emit();
      return result;
    },

    async checkMissing(list: readonly string[]): Promise<string[]> {
      await delay(latencyMs);
      if (connection() !== 'connected') {
        throw new Error("PC not reachable — will retry when you're home.");
      }
      return list.filter((hash) => !stored.has(hash));
    },

    async upload(photo: HashedPhoto, uploadOptions: UploadOptions = {}): Promise<UploadResult> {
      requirePc();
      if (connection() !== 'connected') {
        throw new Error("PC not reachable — upload queued for when you're home.");
      }
      if (options.failUploads) {
        throw new Error('The PC rejected the upload. It will retry later.');
      }
      if (uploadOptions.signal?.aborted) throw new Error('Upload cancelled.');
      if (stored.has(photo.hash)) {
        return { hash: photo.hash, status: 'duplicate' };
      }

      phase = 'uploading';
      currentPhoto = photo.photo.filename;
      const total = photo.photo.size;
      const steps = 4;
      for (let step = 1; step <= steps; step += 1) {
        await delay(Math.max(30, latencyMs));
        if (uploadOptions.signal?.aborted) {
          phase = 'idle';
          currentPhoto = null;
          emit();
          throw new Error('Upload cancelled.');
        }
        uploadedBytes = Math.round((total * step) / steps);
        uploadOptions.onProgress?.({ sentBytes: uploadedBytes, totalBytes: total });
        emit();
      }

      stored.add(photo.hash);
      phase = 'idle';
      currentPhoto = null;
      uploadedBytes = 0;
      emit();
      return { hash: photo.hash, status: 'uploaded' };
    },

    async status(): Promise<BackupStatus> {
      await delay(Math.min(latencyMs, 60));
      return buildStatus();
    },

    async pairWithQr(payload: PairingPayload | string): Promise<PairedPc> {
      await delay(latencyMs);
      const parsed =
        typeof payload === 'string' ? parsePairingPayload(payload) : payload;
      pairedPc = {
        name: parsed.serverName,
        addresses: parsed.addresses,
        port: parsed.port,
        fingerprint: parsed.fingerprint,
        pairedAt: new Date().toISOString(),
      };
      emit();
      return pairedPc;
    },

    async discoverPc(): Promise<never[]> {
      await delay(latencyMs * 3);
      return [];
    },

    async getSettings(): Promise<EngineSettings> {
      await delay(Math.min(latencyMs, 50));
      return { ...settings };
    },

    async setSettings(update: EngineSettingsUpdate): Promise<EngineSettings> {
      await delay(Math.min(latencyMs, 50));
      settings = { ...settings, ...update };
      emit();
      return { ...settings };
    },

    async deviceStatus(): Promise<DeviceHealth> {
      await delay(Math.min(latencyMs, 50));
      // The mock presents a battery-optimization warning so the guidance
      // screen stays exercisable in the browser.
      return {
        batteryOptimized: true,
        manufacturer: 'mock',
        model: 'browser',
        notificationsAllowed:
          typeof Notification !== 'undefined' && Notification.permission === 'granted',
      };
    },

    async requestBatteryExemption(): Promise<{ granted: boolean }> {
      await delay(Math.min(latencyMs, 50));
      return { granted: false };
    },

    async openBatterySettings(): Promise<void> {
      await delay(Math.min(latencyMs, 50));
    },

    async factoryReset(): Promise<void> {
      await delay(Math.min(latencyMs, 50));
      hashes.clear();
      settings = { wifiOnly: true, chargingOnly: false, autoBackup: true };
      pairedPc = null;
      emit();
    },

    async requestNotificationPermission(): Promise<{ granted: boolean }> {
      await delay(Math.min(latencyMs, 50));
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        await Notification.requestPermission();
      }
      return {
        granted: typeof Notification !== 'undefined' && Notification.permission === 'granted',
      };
    },

    async fetchTimeline(cursor: string | null = null, limit = 120): Promise<TimelinePage> {
      await delay(latencyMs);
      const offset = cursor ? Number.parseInt(cursor, 10) || 0 : 0;
      const pageSize = Math.max(1, Math.min(limit, 300));
      const items = library.slice(offset, offset + pageSize);
      const next = offset + items.length;
      return {
        items,
        nextCursor: next < library.length ? String(next) : null,
      };
    },

    subscribe(listener: (status: BackupStatus) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async photoStates(limit = 50): Promise<PhonePhotoState[]> {
      await delay(Math.min(latencyMs, 40));
      return phonePhotos.slice(0, limit).map((photo) => ({
        photo,
        state: stateFor(photo),
        hash: hashes.get(photo.id) ?? null,
        error: null,
        thumbUrl: svgTile(String(phonePhotos.indexOf(photo) + 1), phonePhotos.indexOf(photo) * 29),
        originalUrl: svgTile(`Photo ${phonePhotos.indexOf(photo) + 1}`, phonePhotos.indexOf(photo) * 29, true),
      }));
    },

    /** Deletes the sample asset from the sample PC's library. */
    async deleteAsset(assetId: string): Promise<void> {
      await delay(latencyMs);
      const index = library.findIndex((asset) => asset.id === assetId);
      if (index >= 0) library.splice(index, 1);
    },

    /**
     * Simulates one pass: scan, hash, check, then upload everything the
     * sample PC is missing, with the same phase transitions as the engine.
     */
    async startBackup(): Promise<BackupStatus> {
      if (!pairedPc) throw new Error('Pair with your PC first.');
      if (connection() !== 'connected') {
        phase = 'paused';
        currentPhoto = null;
        emit();
        return buildStatus();
      }

      for (const step of ['scanning', 'hashing', 'checking'] as const) {
        phase = step;
        emit();
        await delay(latencyMs);
      }

      phase = 'uploading';
      emit();
      failedIds = new Set();
      for (const photo of phonePhotos) {
        if (stored.has(hashes.get(photo.id) ?? '')) continue;
        currentPhoto = photo.filename;
        uploadedBytes = 0;
        const total = photo.size;
        const steps = 3;
        for (let step = 1; step <= steps; step += 1) {
          await delay(Math.max(20, latencyMs));
          uploadedBytes = Math.round((total * step) / steps);
          emit();
        }
        if (options.failUploads && failedIds.size < 2) {
          failedIds.add(photo.id);
        } else {
          stored.add(hashes.get(photo.id) ?? '');
        }
      }

      phase = failedIds.size > 0 ? 'paused' : 'idle';
      currentPhoto = null;
      uploadedBytes = 0;
      emit();
      return buildStatus();
    },
  };

  function stateFor(photo: PhonePhoto): PhotoBackupState {
    if (failedIds.has(photo.id)) return 'failed';
    if (currentPhoto === photo.filename && phase === 'uploading') return 'uploading';
    if (stored.has(hashes.get(photo.id) ?? '')) return 'backedUp';
    if (phase === 'hashing' || phase === 'checking') return 'new';
    return 'missing';
  }

  return engine;
}

export const DEMO_PAIRING_PAYLOAD: PairingPayload = {
  version: 1,
  serverName: 'STUDIO-PC',
  addresses: ['192.168.1.24'],
  port: 8427,
  fingerprint: DEMO_FINGERPRINT,
  token: DEMO_TOKEN,
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
};
