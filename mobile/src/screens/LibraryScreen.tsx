import { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState, PhotoGrid, Viewer } from '@xue-mint/shared';
import type { GalleryAsset } from '@xue-mint/shared';
import type { BackupStatus, EngineMode, PhonePhotoState } from '../engine';
import { AlertIcon, CheckCircleIcon, CloudIcon, CloudOffIcon, SearchIcon } from '../components/icons';

interface LibraryScreenProps {
  engine: import('../engine').BackupEngine;
  status: BackupStatus | null;
  mode: EngineMode;
  onPair: () => void;
}

interface PhoneLibraryState {
  assets: GalleryAsset[];
  states: PhonePhotoState[];
  loading: boolean;
  error: string | null;
}

const PAGE_SIZE = 120;

/** Small badge over each library tile showing that photo's backup state. */
function backupBadge(state: PhonePhotoState['state']) {
  if (state === 'backedUp') {
    return (
      <span title="Backed up">
        <CheckCircleIcon className="h-3 w-3" />
      </span>
    );
  }
  if (state === 'uploading' || state === 'missing') {
    return (
      <span title={state === 'uploading' ? 'Uploading' : 'Waiting to back up'}>
        <CloudIcon className="h-3 w-3" />
      </span>
    );
  }
  if (state === 'failed') {
    return (
      <span title="Failed">
        <AlertIcon className="h-3 w-3" />
      </span>
    );
  }
  return (
    <span title="Not checked yet">
      <CloudOffIcon className="h-3 w-3" />
    </span>
  );
}

function badgeKey(state: PhonePhotoState['state']): string {
  return state;
}

export function LibraryScreen({
  engine,
  status,
  mode,
  onPair,
}: LibraryScreenProps) {
  const phonePhotos = status?.phonePhotos ?? 0;
  const backedUp = status?.backedUp ?? 0;
  const pending = status?.pending ?? 0;
  const failed = status?.failed ?? 0;
  const progress = phonePhotos > 0 ? Math.round((backedUp / phonePhotos) * 100) : 0;

  const [library, setLibrary] = useState<PhoneLibraryState>({
    assets: [],
    states: [],
    loading: true,
    error: null,
  });
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLibrary((current) => ({ ...current, loading: true, error: null }));
    try {
      const states = await engine.photoStates(PAGE_SIZE * 2);
      setLibrary({
        assets: [],
        states,
        loading: false,
        error: null,
      });
    } catch (cause) {
      setLibrary({
        assets: [],
        states: [],
        loading: false,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }, [engine]);

  useEffect(() => {
    void load();
  }, [load]);

  // Follow live status so badges and counters track backup passes.
  useEffect(() => {
    const unsubscribe = engine.subscribe((next) => {
      if (next.phase === 'idle') void load();
    });
    return () => {
      unsubscribe();
    };
  }, [engine, load]);

  const gridAssets = useMemo(
    () =>
      library.states.map((state) => ({
        id: `phone-${state.photo.id}`,
        type: 'photo' as const,
        filename: state.photo.filename,
        takenAt: state.photo.takenAt,
        addedAt: state.photo.takenAt,
        width: state.photo.width,
        height: state.photo.height,
        size: state.photo.size,
        thumbUrl: state.thumbUrl ?? '',
        originalUrl: state.originalUrl ?? '',
      } satisfies GalleryAsset)),
    [library.states]
  );

  const stateById = useMemo(() => {
    const map = new Map<string, PhonePhotoState['state']>();
    library.states.forEach((state) => map.set(`phone-${state.photo.id}`, state.state));
    return map;
  }, [library.states]);

  const visibleCount = Math.min(pageSize, gridAssets.length);
  const visibleAssets = gridAssets.slice(0, visibleCount);

  return (
    <div className="screen-scroll min-h-0 flex-1 overflow-y-auto bg-app">
      <div className="safe-top px-4 pb-2 pt-3">
        <h1 className="text-[23px] font-bold tracking-tight">Library</h1>
        <p className="text-[11px] text-muted">What is on this phone and your PC</p>
      </div>

      <div className="space-y-3 px-4 pb-6">
        <div className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
          <div className="flex items-center gap-2">
            <h2 className="text-[13px] font-semibold">On this phone</h2>
            <span className="ml-auto rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-semibold text-muted">
              {mode === 'mock' ? 'Sample data' : 'This device'}
            </span>
          </div>
          <div className="mt-3 flex items-end justify-between gap-3">
            <div>
              <p className="text-[26px] font-bold leading-none">{phonePhotos}</p>
              <p className="mt-1 text-[11px] text-muted">photos found in the phone library</p>
            </div>
            <p className="text-[11px] font-semibold text-success">{progress}% backed up</p>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-brand transition-[width]"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="mt-3 flex items-center justify-between text-[11px] text-muted">
            <span>{backedUp} on your PC</span>
            <span>
              {pending} waiting
              {failed > 0 ? ` · ${failed} failed` : ''}
            </span>
          </div>
        </div>

        <section>
          <div className="flex items-center justify-between px-1 pb-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              Phone photos
            </h2>
            <button
              type="button"
              className="text-[11px] font-semibold text-brand"
              onClick={() => void load()}
            >
              {library.loading ? 'Reading…' : 'Refresh'}
            </button>
          </div>
          {library.error ? (
            <EmptyState
              tone="error"
              title="Could not read the phone library"
              description={library.error}
              actionLabel="Try again"
              onAction={() => void load()}
            />
          ) : library.loading && gridAssets.length === 0 ? (
            <EmptyState busy title="Reading your phone library" description="Listing the photos on this device." />
          ) : gridAssets.length === 0 ? (
            <EmptyState
              title="No photos found"
              description="Grant photo access in Settings to let the engine read the library."
              actionLabel="Pair with your PC"
              onAction={onPair}
            />
          ) : (
            <div className="rounded-2xl border border-line bg-surface p-1 shadow-sm">
              <PhotoGrid
                assets={visibleAssets}
                onOpen={(_asset, index) => setViewerIndex(index)}
                ariaLabel="Phone library"
                minTileSize={104}
                gap={2}
                headerHeight={40}
                horizontalPadding={4}
                showCaptions={false}
                initialWidth={390}
                tileBadge={(asset) => backupBadge(stateById.get(asset.id) ?? 'new')}
                tileBadgeKey={(asset) => badgeKey(stateById.get(asset.id) ?? 'new')}
                onEndReached={
                  visibleCount < gridAssets.length
                    ? () => setPageSize((current) => current + PAGE_SIZE)
                    : undefined
                }
              />
              {visibleCount < gridAssets.length ? (
                <button
                  type="button"
                  className="mx-auto mb-2 block rounded-full border border-line px-3 py-1.5 text-[11px] font-semibold text-ink"
                  onClick={() => setPageSize((current) => current + PAGE_SIZE)}
                >
                  Show more ({gridAssets.length - visibleCount} left)
                </button>
              ) : null}
            </div>
          )}
          <p className="mt-2 px-1 text-[10px] leading-relaxed text-muted">
            Every tile carries its backup state: a green check means the PC has
            the photo, a cloud means it is queued or uploading, a red mark
            means the last attempt failed.
          </p>
        </section>

        <div className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
          <label className="flex items-center gap-2 rounded-full border border-line bg-app px-3 py-2 text-muted">
            <SearchIcon className="h-4 w-4 flex-none" />
            <input
              type="search"
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-muted"
              placeholder="Search your photos"
              disabled
              aria-label="Search your photos (not available yet)"
            />
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-semibold">
              Soon
            </span>
          </label>
          <p className="mt-2 text-[11px] leading-snug text-muted">
            Search by date, place or file name is not available yet.
          </p>
        </div>

        <div className="rounded-2xl border border-dashed border-line bg-surface/60 p-5 text-center">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-surface-2 text-brand">
            <CloudIcon className="h-5 w-5" />
          </div>
          <h2 className="mt-3 text-[14px] font-semibold">Albums and folders</h2>
          <p className="mx-auto mt-1 max-w-[36ch] text-[12px] leading-relaxed text-muted">
            Grouped albums, favourites and folders from your PC will appear here.
          </p>
        </div>

        {!status?.pairedPc ? (
          <button
            type="button"
            className="w-full rounded-2xl bg-brand px-4 py-3 text-[13px] font-semibold text-white shadow-sm"
            onClick={onPair}
          >
            Pair with your PC
          </button>
        ) : null}
      </div>

      {viewerIndex !== null && gridAssets[viewerIndex] ? (
        <Viewer
          key="phone-viewer"
          assets={gridAssets}
          index={viewerIndex}
          onClose={() => setViewerIndex(null)}
          onIndexChange={setViewerIndex}
          swipeThreshold={40}
        />
      ) : null}
    </div>
  );
}
