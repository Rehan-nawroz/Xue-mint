import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { mergeTimelinePage } from '@xue-mint/shared';
import { useTimeline } from '../hooks/useTimeline';
import { GalleryApiError } from '../api/types';
import { makeApi, makeAsset } from '../test/fixtures';

describe('mergeTimelinePage', () => {
  it('appends new assets and drops duplicates by id', () => {
    const a = makeAsset({ id: 'a' });
    const b = makeAsset({ id: 'b' });
    const c = makeAsset({ id: 'c' });

    const merged = mergeTimelinePage([a, b], [b, c]);
    expect(merged.map((asset) => asset.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('useTimeline', () => {
  it('appends pages without duplicates and stops when the cursor is exhausted', async () => {
    const a = makeAsset({ id: 'a' });
    const b = makeAsset({ id: 'b' });
    const c = makeAsset({ id: 'c' });
    const fetchTimeline = vi
      .fn()
      .mockResolvedValueOnce({ items: [a, b], nextCursor: 'page-2' })
      .mockResolvedValueOnce({ items: [b, c], nextCursor: null });
    const api = makeApi({ fetchTimeline });

    const { result } = renderHook(() => useTimeline(api));
    await waitFor(() => expect(result.current.assets).toHaveLength(2));
    expect(result.current.hasMore).toBe(true);

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.assets.map((asset) => asset.id)).toEqual(['a', 'b', 'c']));
    expect(result.current.hasMore).toBe(false);

    act(() => result.current.loadMore());
    expect(fetchTimeline).toHaveBeenCalledTimes(2);
    expect(result.current.loadingMore).toBe(false);
  });

  it('keeps loaded photos when a later page fails', async () => {
    const a = makeAsset({ id: 'a' });
    const fetchTimeline = vi
      .fn()
      .mockResolvedValueOnce({ items: [a], nextCursor: 'page-2' })
      .mockRejectedValueOnce(new GalleryApiError(0, 'NETWORK', 'offline'));
    const api = makeApi({ fetchTimeline });

    const { result } = renderHook(() => useTimeline(api));
    await waitFor(() => expect(result.current.assets).toHaveLength(1));

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.moreError?.code).toBe('NETWORK'));

    expect(result.current.assets).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it('reports the first-page failure and can retry it', async () => {
    const a = makeAsset({ id: 'a' });
    const fetchTimeline = vi
      .fn()
      .mockRejectedValueOnce(new GalleryApiError(0, 'NETWORK', 'offline'))
      .mockResolvedValueOnce({ items: [a], nextCursor: null });
    const api = makeApi({ fetchTimeline });

    const { result } = renderHook(() => useTimeline(api));
    await waitFor(() => expect(result.current.error?.code).toBe('NETWORK'));
    expect(result.current.assets).toHaveLength(0);

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.assets).toHaveLength(1));
    expect(result.current.error).toBeNull();
  });
});
