import { createServerApi } from './client';
import { createMockApi } from './mock';
import type { GalleryApi } from './types';

export type { GalleryApi } from './types';

/**
 * Chooses the gallery backend: the real server by default, generated data with
 * `?mock=1` or `VITE_API_MODE=mock` for UI work without a running PC.
 */
export function createApi(): GalleryApi {
  const params = new URLSearchParams(window.location.search);
  const configured = import.meta.env.VITE_API_MODE as string | undefined;
  const mock = configured === 'mock' || params.get('mock') === '1';
  if (!mock) return createServerApi();

  // `?count=5000` generates a large sample library for scrolling checks.
  const requested = Number(params.get('count'));
  const options =
    Number.isFinite(requested) && requested > 0
      ? { count: Math.min(Math.floor(requested), 50_000) }
      : undefined;
  return createMockApi(options);
}
