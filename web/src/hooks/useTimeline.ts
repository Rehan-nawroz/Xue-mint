import { useCallback, useEffect, useRef, useState } from 'react';
import { mergeTimelinePage } from '@xue-mint/shared';
import type { GalleryAsset } from '@xue-mint/shared';
import type { GalleryApi } from '../api/types';
import { GalleryApiError, toGalleryApiError } from '../api/types';

export interface TimelineState {
  assets: GalleryAsset[];
  loading: boolean;
  loadingMore: boolean;
  /** The trimmed query whose results are currently loaded or loading. */
  appliedQuery: string;
  /** Failure of the first page; the grid is empty when this is set. */
  error: GalleryApiError | null;
  /** Failure while appending a later page; already loaded photos stay visible. */
  moreError: GalleryApiError | null;
  hasMore: boolean;
  loadMore: () => void;
  retry: () => void;
  /** Removes an already-deleted asset from the loaded pages. */
  removeAsset: (id: string) => void;
  /** Applies a successful rename without reloading the timeline. */
  renameAsset: (id: string, filename: string) => void;
}

const SEARCH_DEBOUNCE_MS = 220;

/**
 * Loads the newest-first timeline and appends older pages without duplicates.
 * Searches debounce briefly, and a response from an older query can never
 * overwrite newer results. A failed later page never clears what is on screen.
 */
export function useTimeline(api: GalleryApi, query = ''): TimelineState {
  const trimmedQuery = query.trim();
  const [appliedQuery, setAppliedQuery] = useState(trimmedQuery);
  const [assets, setAssets] = useState<GalleryAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<GalleryApiError | null>(null);
  const [moreError, setMoreError] = useState<GalleryApiError | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const nextCursor = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);
  const generation = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    if (trimmedQuery === appliedQuery) return;
    const timer = window.setTimeout(() => setAppliedQuery(trimmedQuery), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [trimmedQuery, appliedQuery]);

  const loadFirst = useCallback(async () => {
    const request = ++generation.current;
    nextCursor.current = null;
    loadingMoreRef.current = false;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setMoreError(null);
    setAssets([]);
    setHasMore(false);

    try {
      await api.ensureSession();
      const page = await api.fetchTimeline(null, 200, appliedQuery);
      if (!alive.current || request !== generation.current) return;
      nextCursor.current = page.nextCursor;
      setAssets(page.items);
      setHasMore(Boolean(page.nextCursor));
    } catch (caught) {
      if (!alive.current || request !== generation.current) return;
      setError(toGalleryApiError(caught));
    } finally {
      if (alive.current && request === generation.current) setLoading(false);
    }
  }, [api, appliedQuery]);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !nextCursor.current) return;
    const request = generation.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.fetchTimeline(nextCursor.current, 200, appliedQuery);
      if (!alive.current || request !== generation.current) return;
      nextCursor.current = page.nextCursor;
      setAssets((current) => mergeTimelinePage(current, page.items));
      setHasMore(Boolean(page.nextCursor));
    } catch (caught) {
      if (!alive.current || request !== generation.current) return;
      setMoreError(toGalleryApiError(caught));
    } finally {
      loadingMoreRef.current = false;
      if (alive.current && request === generation.current) setLoadingMore(false);
    }
  }, [api, appliedQuery]);

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
    appliedQuery,
    error,
    moreError,
    hasMore,
    loadMore: () => void loadMore(),
    retry: () => void loadFirst(),
    removeAsset: (id) => setAssets((current) => current.filter((asset) => asset.id !== id)),
    renameAsset: (id, filename) =>
      setAssets((current) =>
        current.map((asset) => (asset.id === id ? { ...asset, filename } : asset))
      ),
  };
}
