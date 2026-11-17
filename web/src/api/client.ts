import type { GalleryAsset } from '@xue-mint/shared';
import type {
  GalleryApi,
  LibraryStatus,
  PairedDevice,
  ServerSettings,
  SettingsUpdate,
  TimelinePage,
} from './types';
import { GalleryApiError } from './types';

interface AssetDto {
  id: string;
  hash: string;
  filename: string | null;
  type: 'photo' | 'video';
  size: number;
  takenAt: string | null;
  gps: string | null;
  width: number | null;
  height: number | null;
  addedAt: string;
}

interface TimelineDto {
  items: AssetDto[];
  nextCursor: string | null;
}

interface DeviceDto {
  id: string;
  name: string;
  pairedAt: string;
  lastSeenAt: string | null;
  revoked: boolean;
}

interface DevicesDto {
  devices: DeviceDto[];
}

interface ApiErrorDto {
  code?: string;
  message?: string;
}

function assetUrl(id: string, kind: 'thumb' | 'original'): string {
  return `/assets/${encodeURIComponent(id)}/${kind}`;
}

function toAsset(dto: AssetDto): GalleryAsset {
  return {
    id: dto.id,
    type: dto.type === 'video' ? 'video' : 'photo',
    filename: dto.filename,
    takenAt: dto.takenAt,
    addedAt: dto.addedAt,
    width: dto.width,
    height: dto.height,
    size: dto.size,
    thumbUrl: assetUrl(dto.id, 'thumb'),
    originalUrl: assetUrl(dto.id, 'original'),
  };
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new GalleryApiError(
      0,
      'NETWORK',
      'The gallery server could not be reached. Make sure the PC is on and the server is running.'
    );
  }
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await request(path, init);
  if (response.status === 204) return undefined as T;

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const dto = (body ?? {}) as ApiErrorDto;
    throw new GalleryApiError(
      response.status,
      dto.code ?? 'REQUEST_FAILED',
      dto.message ?? 'The server could not complete that request.'
    );
  }

  return body as T;
}

/** Talks to the server that serves this page. */
export function createServerApi(): GalleryApi {
  return {
    mode: 'server',

    async ensureSession() {
      const response = await request('/local/session', { method: 'POST' });
      if (response.ok || response.status === 204) return;

      let body: ApiErrorDto = {};
      try {
        body = (await response.json()) as ApiErrorDto;
      } catch {
        body = {};
      }
      throw new GalleryApiError(
        response.status,
        body.code ?? 'SESSION_FAILED',
        body.message ?? 'This browser could not open the gallery session.'
      );
    },

    async fetchTimeline(cursor = null, limit = 200): Promise<TimelinePage> {
      const params = new URLSearchParams();
      if (cursor) params.set('cursor', cursor);
      if (limit) params.set('limit', String(limit));
      const query = params.toString();
      const dto = await requestJson<TimelineDto>(`/assets${query ? `?${query}` : ''}`);
      return {
        items: dto.items.map(toAsset),
        nextCursor: dto.nextCursor ?? null,
      };
    },

    fetchStatus(): Promise<LibraryStatus> {
      return requestJson<LibraryStatus>('/local/status');
    },

    async fetchDevices(): Promise<PairedDevice[]> {
      const dto = await requestJson<DevicesDto>('/devices');
      return dto.devices;
    },

    async revokeDevice(id: string) {
      await requestJson<void>(`/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },

    fetchSettings(): Promise<ServerSettings> {
      return requestJson<ServerSettings>('/local/settings');
    },

    saveSettings(update: SettingsUpdate): Promise<ServerSettings> {
      return requestJson<ServerSettings>('/local/settings', {
        method: 'PUT',
        body: JSON.stringify(update),
      });
    },
  };
}
