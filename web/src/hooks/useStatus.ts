import { useCallback, useEffect, useRef, useState } from 'react';
import type { GalleryApi, LibraryStatus } from '../api/types';
import { GalleryApiError, toGalleryApiError } from '../api/types';

export interface StatusState {
  status: LibraryStatus | null;
  loading: boolean;
  error: GalleryApiError | null;
  refresh: () => void;
}

/** Library totals refresh on load and periodically; failures never clear the last good value. */
export function useStatus(api: GalleryApi, intervalMs = 15_000): StatusState {
  const [status, setStatus] = useState<LibraryStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<GalleryApiError | null>(null);
  const alive = useRef(true);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const next = await api.fetchStatus();
      if (!alive.current) return;
      setStatus(next);
      setError(null);
    } catch (caught) {
      if (!alive.current) return;
      setError(toGalleryApiError(caught));
    } finally {
      busy.current = false;
      if (alive.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), intervalMs);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh, intervalMs]);

  return { status, loading, error, refresh: () => void refresh() };
}
