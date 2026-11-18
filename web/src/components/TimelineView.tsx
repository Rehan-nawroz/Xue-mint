import { EmptyState, PhotoGrid } from '@xue-mint/shared';
import type { GalleryAsset } from '@xue-mint/shared';
import type { TimelineState } from '../hooks/useTimeline';
import { ErrorPane } from './ErrorPane';

interface TimelineViewProps {
  timeline: TimelineState;
  onOpen: (asset: GalleryAsset, index: number) => void;
  query: string;
  onQueryChange: (query: string) => void;
}

function SearchIcon() {
  return (
    <svg className="search-field__icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="m15.5 15.5 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** Timeline states with file-name search and the virtualized grid. */
export function TimelineView({ timeline, onOpen, query, onQueryChange }: TimelineViewProps) {
  const { assets, loading, error, loadingMore, moreError, hasMore, loadMore, retry } = timeline;
  const hasQuery = query.trim().length > 0;
  const showSearch = assets.length > 0 || hasQuery || loading;
  const count = `${assets.length}${hasMore ? '+' : ''}`;
  const resultLabel = loading
    ? hasQuery
      ? 'Searching…'
      : 'Loading…'
    : hasQuery
      ? `${count} ${assets.length === 1 ? 'match' : 'matches'}`
      : `${count} ${assets.length === 1 ? 'file' : 'files'}`;

  let body;
  if (loading && assets.length === 0) {
    body = (
      <EmptyState
        busy
        title={hasQuery ? 'Searching your photos' : 'Loading your photos'}
        description={
          hasQuery
            ? `Looking for “${query.trim()}” in the library on this PC.`
            : 'Reading the library on this PC.'
        }
      />
    );
  } else if (error && assets.length === 0) {
    body = <ErrorPane error={error} onRetry={retry} />;
  } else if (assets.length === 0) {
    body = hasQuery ? (
      <EmptyState
        title={`No photos match “${query.trim()}”`}
        description="Try a different file name, or clear the search to see the whole library."
        actionLabel="Show all photos"
        onAction={() => onQueryChange('')}
      />
    ) : (
      <EmptyState
        title="No photos yet"
        description="Add photos to the watched folder on this PC, or back them up from your phone. They appear here as soon as they are indexed."
        actionLabel="Refresh"
        onAction={retry}
      />
    );
  } else {
    body = (
      <>
        <PhotoGrid
          key={timeline.appliedQuery || 'all-photos'}
          assets={assets}
          onOpen={onOpen}
          onEndReached={hasMore ? loadMore : undefined}
          ariaLabel={hasQuery ? 'Photo search results' : 'Photo timeline'}
        />
        <div className="timeline__footer">
          {loadingMore ? (
            <span role="status">{hasQuery ? 'Loading more matches…' : 'Loading older photos…'}</span>
          ) : moreError ? (
            <span className="timeline__error" role="alert">
              Couldn't load {hasQuery ? 'more matches' : 'older photos'}. {moreError.message}
              <button type="button" className="link-button" onClick={loadMore}>
                Try again
              </button>
            </span>
          ) : hasMore ? (
            <button type="button" className="secondary-button" onClick={loadMore}>
              {hasQuery ? 'Load more matches' : 'Load older photos'}
            </button>
          ) : (
            <span className="timeline__end">
              {hasQuery ? "That's every match." : "That's everything in this library."}
            </span>
          )}
        </div>
      </>
    );
  }

  return (
    <div className="timeline">
      {showSearch ? (
        <div className="library-toolbar">
          <label className="search-field">
            <span className="visually-hidden">Search photos by file name</span>
            <SearchIcon />
            <input
              type="search"
              value={query}
              placeholder="Search by file name"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => onQueryChange(event.target.value)}
            />
            {query.length > 0 ? (
              <button
                type="button"
                className="search-field__clear"
                aria-label="Clear search"
                onClick={() => onQueryChange('')}
              >
                ×
              </button>
            ) : null}
          </label>
          <span className="library-toolbar__count" aria-live="polite">
            {resultLabel}
          </span>
        </div>
      ) : null}
      <div className="timeline__body">{body}</div>
    </div>
  );
}
