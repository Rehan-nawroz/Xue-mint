import { EmptyState, PhotoGrid } from '@xue-mint/shared';
import type { GalleryAsset } from '@xue-mint/shared';
import React from 'react';
import logoUrl from '../../../assets/brand/mock-logo.svg';
import { BackupStatusBar } from '../components/BackupStatusBar';
import type { BackupEngine, BackupStatus, PhonePhotoState } from '../engine';
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

/**
 * Pick waiting photos and send them to the PC right away — the same pass the
 * "Back up now" button runs, but opened from the photos the user chose.
 */
function SendPhotosSheet({
  engine,
  onClose,
}: {
  engine: BackupEngine;
  onClose: () => void;
}) {
  const [states, setStates] = React.useState<PhonePhotoState[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [sending, setSending] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const loaded = await engine.photoStates(200);
        if (!alive) return;
        const waiting = loaded.filter(
          (item) => item.state === 'new' || item.state === 'hashed' || item.state === 'missing'
        );
        setStates(waiting);
        setSelected(new Set(waiting.map((item) => item.photo.id)));
      } catch (caught) {
        if (alive) setError(caught instanceof Error ? caught.message : 'Could not read the queue.');
      }
    })();
    return () => {
      alive = false;
    };
  }, [engine]);

  const send = async () => {
    setSending(true);
    try {
      await engine.startBackup();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start the send.');
      setSending(false);
    }
  };

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col justify-end bg-ink/60"
      role="dialog"
      aria-label="Send photos now"
    >
      <div className="max-h-[70%] overflow-y-auto rounded-t-3xl bg-app p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-bold">Photos waiting to back up</h2>
          <button type="button" className="text-[12px] font-semibold text-muted" onClick={onClose}>
            Close
          </button>
        </div>
        {error ? (
          <p className="mt-3 rounded-xl bg-danger-soft px-3 py-2 text-[12px] text-danger" role="alert">
            {error}
          </p>
        ) : null}
        {states === null && !error ? (
          <p className="mt-4 text-[12px] text-muted">Reading your queue…</p>
        ) : null}
        {states !== null && states.length === 0 ? (
          <p className="mt-4 text-[12px] text-muted">Everything is already on your PC.</p>
        ) : null}
        {states !== null && states.length > 0 ? (
          <>
            <ul className="mt-3 flex flex-col gap-2">
              {states.map((item) => {
                const checked = selected.has(item.photo.id);
                return (
                  <li key={item.photo.id}>
                    <label className="flex items-center gap-3 rounded-xl border border-line px-3 py-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => {
                          const next = new Set(selected);
                          if (event.target.checked) next.add(item.photo.id);
                          else next.delete(item.photo.id);
                          setSelected(next);
                        }}
                      />
                      {item.thumbUrl ? (
                        <img
                          className="h-10 w-10 rounded-lg object-cover"
                          src={item.thumbUrl}
                          alt=""
                          width={40}
                          height={40}
                        />
                      ) : null}
                      <span className="min-w-0 flex-1 truncate text-[12px]">
                        {item.photo.filename}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <button
              type="button"
              data-testid="send-now"
              className="mt-3 w-full rounded-full bg-brand px-3 py-2.5 text-[12px] font-semibold text-white disabled:opacity-50"
              disabled={sending || selected.size === 0}
              onClick={() => void send()}
            >
              {sending
                ? 'Sending…'
                : selected.size === states.length
                  ? `Send all ${states.length} now`
                  : `Send ${selected.size} now`}
            </button>
          </>
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
  const countLabel = loading ? '' : `${assets.length}${hasMore ? '+' : ''}`;
  const [sendOpen, setSendOpen] = React.useState(false);

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
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="send-photos"
              aria-label="Send photos now"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-[16px] font-semibold leading-none text-white shadow-sm"
              onClick={() => setSendOpen(true)}
            >
              +
            </button>
            <img
              className="h-8 w-8 rounded-full shadow-sm"
              src={logoUrl}
              alt="Xue-Mint (mock logo)"
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

      {sendOpen ? <SendPhotosSheet engine={engine} onClose={() => setSendOpen(false)} /> : null}
    </div>
  );
}
