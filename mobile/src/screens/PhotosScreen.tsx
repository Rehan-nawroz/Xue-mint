import { EmptyState, PhotoGrid } from '@xue-mint/shared';
import type { GalleryAsset } from '@xue-mint/shared';
import logoUrl from '../../../assets/brand/mock-logo.svg';
import { BackupStatusBar } from '../components/BackupStatusBar';
import type { BackupStatus } from '../engine';
import type { TimelineState } from '../hooks/useEngineData';

interface PhotosScreenProps {
  timeline: TimelineState;
  status: BackupStatus | null;
  statusLoading: boolean;
  statusError: string | null;
  onRefreshStatus: () => void;
  onPair: () => void;
  onOpen: (asset: GalleryAsset, index: number) => void;
}

export function PhotosScreen({
  timeline,
  status,
  statusLoading,
  statusError,
  onRefreshStatus,
  onPair,
  onOpen,
}: PhotosScreenProps) {
  const { assets, loading, error, loadingMore, moreError, hasMore, loadMore, retry } = timeline;
  const countLabel = loading ? '' : `${assets.length}${hasMore ? '+' : ''}`;

  let body;
  if (loading && assets.length === 0) {
    body = (
      <EmptyState
        busy
        title="Loading your photos"
        description="Reading the library from your PC."
      />
    );
  } else if (error && assets.length === 0) {
    body = (
      <EmptyState
        tone="error"
        title="Could not load your photos"
        description={error}
        actionLabel="Try again"
        onAction={retry}
      />
    );
  } else if (assets.length === 0) {
    body = (
      <EmptyState
        title="No photos yet"
        description="Photos you back up from this phone will show up here, next to the ones already on your PC."
        actionLabel="Refresh"
        onAction={retry}
      />
    );
  } else {
    body = (
      <PhotoGrid
        assets={assets}
        onOpen={onOpen}
        onEndReached={hasMore ? loadMore : undefined}
        ariaLabel="Photo timeline"
        minTileSize={108}
        gap={3}
        headerHeight={44}
        horizontalPadding={2}
        showCaptions={false}
        initialWidth={390}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="safe-top flex-none bg-app">
        <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-3">
          <div>
            <h1 className="text-[23px] font-bold leading-tight tracking-tight">Photos</h1>
            <p className="text-[11px] text-muted">
              {countLabel ? `${countLabel} photos · on your PC` : 'Your library, on your devices'}
            </p>
          </div>
          <img
            className="h-8 w-8 rounded-full shadow-sm"
            src={logoUrl}
            alt="Xue-Mint (mock logo)"
            width={32}
            height={32}
          />
        </div>
      </div>

      <BackupStatusBar
        status={status}
        loading={statusLoading}
        error={statusError}
        onPair={onPair}
        onRetry={onRefreshStatus}
      />

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="mobile-timeline flex min-h-0 flex-1 flex-col">{body}</div>
        {loadingMore ? (
          <div
            className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-ink/80 px-3 py-1 text-[11px] font-medium text-app shadow"
            role="status"
          >
            Loading older photos…
          </div>
        ) : moreError ? (
          <button
            type="button"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-surface px-3 py-1.5 text-[11px] font-semibold text-danger shadow"
            onClick={loadMore}
          >
            Couldn't load more · Try again
          </button>
        ) : null}
      </div>
    </div>
  );
}
