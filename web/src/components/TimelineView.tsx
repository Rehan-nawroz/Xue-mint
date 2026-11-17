import { EmptyState, PhotoGrid } from '@xue-mint/shared';
import type { GalleryAsset } from '@xue-mint/shared';
import type { TimelineState } from '../hooks/useTimeline';
import { ErrorPane } from './ErrorPane';

interface TimelineViewProps {
  timeline: TimelineState;
  onOpen: (asset: GalleryAsset, index: number) => void;
}

/** Timeline states: loading, unreachable, empty, and the grid itself. */
export function TimelineView({ timeline, onOpen }: TimelineViewProps) {
  const { assets, loading, error, loadingMore, moreError, hasMore, loadMore, retry } = timeline;

  if (loading && assets.length === 0) {
    return <EmptyState busy title="Loading your photos" description="Reading the library on this PC." />;
  }

  if (error && assets.length === 0) {
    return <ErrorPane error={error} onRetry={retry} />;
  }

  if (assets.length === 0) {
    return (
      <EmptyState
        title="No photos yet"
        description="Add photos to the watched folder on this PC, or back them up from your phone. They appear here as soon as they are indexed."
        actionLabel="Refresh"
        onAction={retry}
      />
    );
  }

  return (
    <div className="timeline">
      <PhotoGrid
        assets={assets}
        onOpen={onOpen}
        onEndReached={hasMore ? loadMore : undefined}
        ariaLabel="Photo timeline"
      />
      <div className="timeline__footer">
        {loadingMore ? (
          <span role="status">Loading older photos…</span>
        ) : moreError ? (
          <span className="timeline__error" role="alert">
            Couldn't load older photos. {moreError.message}
            <button type="button" className="link-button" onClick={loadMore}>
              Try again
            </button>
          </span>
        ) : hasMore ? (
          <button type="button" className="secondary-button" onClick={loadMore}>
            Load older photos
          </button>
        ) : (
          <span className="timeline__end">That's everything in this library.</span>
        )}
      </div>
    </div>
  );
}
