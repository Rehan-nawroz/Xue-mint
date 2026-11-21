import { EmptyState, PhotoGrid, formatBytes } from '@xue-mint/shared';
import type { GalleryAsset } from '@xue-mint/shared';
import React from 'react';
import logoUrl from '../../../assets/brand/logo.png';
import { BackupStatusBar } from '../components/BackupStatusBar';
import type { BackupEngine, BackupStatus, ImportProgress, ImportSummary } from '../engine';
import type { TimelineState } from '../hooks/useEngineData';

interface PhotosScreenProps {
  timeline: TimelineState;
  status: BackupStatus | null;
  statusLoading: boolean;
  statusError: string | null;
  onRefreshStatus: () => void;
  onPair: () => void;
  onOpen: (asset: GalleryAsset, index: number) => void;
  engine: BackupEngine;
}

type ImportState =
  | { kind: 'waiting' }
  | { kind: 'progress'; progress: ImportProgress }
  | { kind: 'done'; summary: ImportSummary }
  | { kind: 'error'; message: string };

const PHASE_LABEL: Record<ImportProgress['phase'], string> = {
  hashing: 'Checking the photo…',
  checking: 'Asking your PC…',
  uploading: 'Sending…',
};

/**
 * Runs the gallery import the plus button starts: the system picker opens,
 * every picked photo is hashed, deduped and streamed to the PC, and the
 * sheet follows the progress until the photos are on both devices.
 */
function ImportSheet({
  engine,
  onClose,
  onImported,
}: {
  engine: BackupEngine;
  onClose: () => void;
  onImported: () => void;
}) {
  const [state, setState] = React.useState<ImportState>({ kind: 'waiting' });
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    let alive = true;
    setState({ kind: 'waiting' });
    void (async () => {
      try {
        const summary = await engine.importFromGallery((progress) => {
          if (alive) setState({ kind: 'progress', progress });
        });
        if (summary.imported + summary.duplicates + summary.failed === 0) {
          // The picker was closed without choosing anything.
          if (alive) onClose();
          return;
        }
        // Refresh even if the sheet is already closed; the import ran.
        onImported();
        if (alive) setState({ kind: 'done', summary });
      } catch (caught) {
        if (!alive) return;
        setState({
          kind: 'error',
          message: caught instanceof Error ? caught.message : 'The photos could not be added.',
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, [engine, attempt, onClose, onImported]);

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col justify-end bg-ink/60"
      role="dialog"
      aria-label="Add photos"
      data-testid="import-sheet"
    >
      <div className="rounded-t-3xl bg-app p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-bold">Add to your library</h2>
          <button type="button" className="text-[12px] font-semibold text-muted" onClick={onClose}>
            Close
          </button>
        </div>

        {state.kind === 'waiting' ? (
          <p className="mt-4 text-[12px] text-muted">Choose photos in your gallery…</p>
        ) : null}

        {state.kind === 'progress' ? (
          <div className="mt-4" data-testid="import-progress">
            <p className="text-[12px] font-semibold">
              Photo {state.progress.current} of {state.progress.total}
            </p>
            <p className="mt-1 truncate text-[12px] text-muted">{state.progress.filename}</p>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-line">
              <div
                className="h-full rounded-full bg-brand transition-[width] duration-300"
                style={{
                  width: `${
                    state.progress.totalBytes > 0
                      ? Math.min(
                          100,
                          Math.round((state.progress.sentBytes / state.progress.totalBytes) * 100)
                        )
                      : 0
                  }%`,
                }}
              />
            </div>
            <p className="mt-1 text-[11px] text-muted">
              {state.progress.phase === 'uploading' && state.progress.sentBytes > 0
                ? `${PHASE_LABEL.uploading} ${formatBytes(state.progress.sentBytes)} of ${formatBytes(
                    state.progress.totalBytes
                  )}`
                : PHASE_LABEL[state.progress.phase]}
            </p>
          </div>
        ) : null}

        {state.kind === 'done' ? (
          <div className="mt-4" data-testid="import-summary">
            <p className="text-[12px] font-semibold text-success">
              Added {state.summary.imported}{' '}
              {state.summary.imported === 1 ? 'photo' : 'photos'} to your library.
            </p>
            {state.summary.duplicates > 0 ? (
              <p className="mt-1 text-[12px] text-muted">
                {state.summary.duplicates}{' '}
                {state.summary.duplicates === 1 ? 'was' : 'were'} already on your PC.
              </p>
            ) : null}
            {state.summary.failures.map((failure) => (
              <p
                key={failure.filename}
                className="mt-2 rounded-xl bg-danger-soft px-3 py-2 text-[12px] text-danger"
              >
                {failure.filename} could not be added: {failure.error}
              </p>
            ))}
            <button
              type="button"
              className="mt-3 w-full rounded-full bg-brand px-3 py-2.5 text-[12px] font-semibold text-white"
              onClick={onClose}
            >
              Done
            </button>
          </div>
        ) : null}

        {state.kind === 'error' ? (
          <div className="mt-4">
            <p className="rounded-xl bg-danger-soft px-3 py-2 text-[12px] text-danger" role="alert">
              {state.message}
            </p>
            <button
              type="button"
              className="mt-3 w-full rounded-full bg-brand px-3 py-2.5 text-[12px] font-semibold text-white"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Try again
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function PhotosScreen({
  timeline,
  status,
  statusLoading,
  statusError,
  onRefreshStatus,
  onPair,
  onOpen,
  engine,
}: PhotosScreenProps) {
  const { assets, loading, error, loadingMore, moreError, hasMore, loadMore, retry } = timeline;
  const countLabel = loading ? '' : `${assets.length}${hasMore ? '+' : ''} photos · on your PC`;
  const [importOpen, setImportOpen] = React.useState(false);

  const closeImport = React.useCallback(() => setImportOpen(false), []);
  const handleImported = React.useCallback(() => {
    retry();
    onRefreshStatus();
  }, [retry, onRefreshStatus]);

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
              {countLabel ? countLabel : 'Your library, on your devices'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="add-photos"
              aria-label="Add photos"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-[16px] font-semibold leading-none text-white shadow-sm"
              onClick={() => setImportOpen(true)}
            >
              +
            </button>
            <img
              className="h-8 w-8 rounded-full shadow-sm"
              src={logoUrl}
              alt="XueMint logo"
              width={32}
              height={32}
            />
          </div>
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

      {importOpen ? (
        <ImportSheet engine={engine} onClose={closeImport} onImported={handleImported} />
      ) : null}
    </div>
  );
}
