import { useCallback, useEffect, useRef, useState } from 'react';
import { mergeTimelinePage } from '@xue-mint/shared';
import type { GalleryAsset } from '@xue-mint/shared';
import type { GalleryApi } from '../api/types';
import { GalleryApiError, toGalleryApiError } from '../api/types';

export interface TimelineState {
  assets: GalleryAsset[];
  loading: boolean;
  loadingMore: boolean;
  /** Failure of the first page; the grid is empty when this is set. */
  error: GalleryApiError | null;
  /** Failure while appending a later page; already loaded photos stay visible. */
  moreError: GalleryApiError | null;
  hasMore: boolean;
  loadMore: () => void;
  retry: () => void;
}

/**
 * Loads the newest-first timeline and appends older pages without duplicates.
 * A failed later page never clears what is already on screen.
 */
export function useTimeline(api: GalleryApi): TimelineState {
  const [assets, setAssets] = useState<GalleryAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<GalleryApiError | null>(null);
  const [moreError, setMoreError] = useState<GalleryApiError | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const nextCursor = useRef<string | null>(null);
  const busy = useRef(false);
  const alive = useRef(true);

  const loadFirst = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    setError(null);
    setMoreError(null);
    try {
      await api.ensureSession();
      const page = await api.fetchTimeline(null);
      if (!alive.current) return;
      nextCursor.current = page.nextCursor;
      setAssets(page.items);
      setHasMore(Boolean(page.nextCursor));
    } catch (caught) {
      if (!alive.current) return;
      nextCursor.current = null;
      setError(toGalleryApiError(caught));
      setHasMore(false);
    } finally {
      busy.current = false;
      if (alive.current) setLoading(false);
    }
  }, [api]);

  const loadMore = useCallback(async () => {
    if (busy.current || !nextCursor.current) return;
    busy.current = true;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.fetchTimeline(nextCursor.current);
      if (!alive.current) return;
      nextCursor.current = page.nextCursor;
      setAssets((current) => mergeTimelinePage(current, page.items));
      setHasMore(Boolean(page.nextCursor));
    } catch (caught) {
      if (!alive.current) return;
      setMoreError(toGalleryApiError(caught));
    } finally {
      busy.current = false;
      if (alive.current) setLoadingMore(false);
    }
  }, [api]);

  useEffect(() => {
    alive.current = true;
    void loadFirst();
    return () => {
      alive.current = false;
    };
  }, [loadFirst]);

  return {
    assets,
    loading,
    loadingMore,
    error,
    moreError,
    hasMore,
    loadMore: () => void loadMore(),
    retry: () => void loadFirst(),
  };
}
