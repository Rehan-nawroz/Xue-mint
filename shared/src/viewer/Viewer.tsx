import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, TouchEvent } from 'react';
import { assetDate, formatDateTime } from '../dates';
import type { GalleryAsset } from '../types';
import { isVideo } from '../types';

export interface ViewerProps {
  assets: readonly GalleryAsset[];
  index: number;
  onClose: () => void;
  onIndexChange: (index: number) => void;
  /** Removes the current asset; the viewer stays on the next available item. */
  onDelete?: (asset: GalleryAsset) => Promise<void>;
  /** Renames the current asset and resolves to the stored file name. */
  onRename?: (asset: GalleryAsset, filename: string) => Promise<string>;
  /** Horizontal distance in pixels that counts as a swipe. */
  swipeThreshold?: number;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input, select, textarea, video[controls], [tabindex]:not([tabindex="-1"])';

/**
 * Full-screen accessible viewer. Handles arrow keys, Escape, touch/pointer
 * swipes, focus containment and focus restoration. Media failures stay inside
 * the viewer and offer a retry, so one broken file never breaks the gallery.
 */
export function Viewer({
  assets,
  index,
  onClose,
  onIndexChange,
  onDelete,
  onRename,
  swipeThreshold = 50,
}: ViewerProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const swipeStart = useRef<number | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [action, setAction] = useState<'rename' | 'delete' | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const asset = assets[index];

  const hasPrevious = index > 0;
  const hasNext = index < assets.length - 1;

  const goPrevious = useCallback(() => {
    if (index > 0) onIndexChange(index - 1);
  }, [index, onIndexChange]);

  const goNext = useCallback(() => {
    if (index < assets.length - 1) onIndexChange(index + 1);
  }, [assets.length, index, onIndexChange]);

  // Remember what had focus, move focus into the dialog, and restore on close.
  useEffect(() => {
    const previous = typeof document !== 'undefined' ? document.activeElement : null;
    const closeButton = dialogRef.current?.querySelector<HTMLButtonElement>('[data-xm-viewer-close]');
    closeButton?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  // Keep the page behind the viewer from scrolling.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    setFailedId(null);
    setAttempt(0);
    setAction(null);
    setActionError(null);
    setWorking(false);
  }, [asset?.id]);

  const closeAction = () => {
    if (working) return;
    setAction(null);
    setActionError(null);
  };

  const openRename = () => {
    if (!asset) return;
    setRenameValue(asset.filename ?? '');
    setActionError(null);
    setAction('rename');
  };

  const openDelete = () => {
    setActionError(null);
    setAction('delete');
  };

  const submitRename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!asset || !onRename || working) return;
    const next = renameValue.trim();
    if (!next) {
      setActionError('Enter a file name.');
      return;
    }
    setWorking(true);
    setActionError(null);
    try {
      await onRename(asset, next);
      setAction(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
    }
  };

  const confirmDelete = async () => {
    if (!asset || !onDelete || working) return;
    setWorking(true);
    setActionError(null);
    try {
      await onDelete(asset);
      setAction(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (action) closeAction();
      else onClose();
      return;
    }
    if (action) return;
    if (
      event.target instanceof HTMLElement &&
      event.target.closest('input, textarea, select')
    ) {
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      goPrevious();
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      goNext();
      return;
    }
    if (event.key === 'Tab') {
      const focusable = dialogRef.current
        ? Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
        : [];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  const onTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    swipeStart.current = event.touches[0]?.clientX ?? null;
  };

  const onTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    const end = event.changedTouches[0]?.clientX;
    if (start === null || end === undefined) return;
    const delta = end - start;
    if (Math.abs(delta) < swipeThreshold) return;
    if (delta < 0) goNext();
    else goPrevious();
  };

  const heading = useMemo(() => {
    if (!asset) return 'Photo viewer';
    return `${isVideo(asset) ? 'Video' : 'Photo'}: ${asset.filename ?? 'Untitled'}`;
  }, [asset]);

  if (!asset) return null;

  const failed = failedId === asset.id;
  const mediaKey = `${asset.id}-${attempt}`;

  return (
    <div
      className="xm-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={heading}
      ref={dialogRef}
      onKeyDown={onKeyDown}
    >
      <div className="xm-viewer__bar">
        <div className="xm-viewer__meta">
          <span className="xm-viewer__name">{asset.filename ?? 'Untitled'}</span>
          <span className="xm-viewer__date">{formatDateTime(assetDate(asset))}</span>
        </div>
        <span className="xm-viewer__counter">
          {index + 1} of {assets.length}
        </span>
        {onRename || onDelete ? (
          <div className="xm-viewer__actions">
            {onRename ? (
              <button type="button" className="xm-viewer__action" onClick={openRename}>
                Rename
              </button>
            ) : null}
            {onDelete ? (
              <button
                type="button"
                className="xm-viewer__action xm-viewer__action--danger"
                onClick={openDelete}
              >
                Delete
              </button>
            ) : null}
          </div>
        ) : null}
        <button
          type="button"
          className="xm-viewer__close"
          data-xm-viewer-close
          onClick={onClose}
          aria-label="Close viewer"
        >
          ✕
        </button>
      </div>

      <div
        className="xm-viewer__stage"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        style={{ touchAction: 'pan-y' }}
      >
        {failed ? (
          <div className="xm-viewer__error" role="alert">
            <p>This file could not be loaded.</p>
            <div className="xm-viewer__error-actions">
              <button
                type="button"
                onClick={() => {
                  setFailedId(null);
                  setAttempt((value) => value + 1);
                }}
              >
                Try again
              </button>
              <a href={asset.originalUrl} target="_blank" rel="noreferrer">
                Open original
              </a>
            </div>
          </div>
        ) : isVideo(asset) ? (
          <video
            key={mediaKey}
            className="xm-viewer__media"
            src={asset.originalUrl}
            controls
            autoPlay
            playsInline
            onError={() => setFailedId(asset.id)}
          />
        ) : (
          <img
            key={mediaKey}
            className="xm-viewer__media"
            src={asset.originalUrl}
            alt={asset.filename ?? 'Photo'}
            onError={() => setFailedId(asset.id)}
          />
        )}
      </div>

      <button
        type="button"
        className="xm-viewer__nav xm-viewer__nav--previous"
        onClick={goPrevious}
        disabled={!hasPrevious}
        aria-label="Previous photo"
      >
        ‹
      </button>
      <button
        type="button"
        className="xm-viewer__nav xm-viewer__nav--next"
        onClick={goNext}
        disabled={!hasNext}
        aria-label="Next photo"
      >
        ›
      </button>

      {action ? (
        <div
          className="xm-viewer__dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeAction();
          }}
        >
          <div
            className="xm-viewer__dialog"
            role={action === 'delete' ? 'alertdialog' : 'dialog'}
            aria-modal="true"
            aria-labelledby="xm-viewer-dialog-title"
          >
            <h2 id="xm-viewer-dialog-title">
              {action === 'delete'
                ? `Delete this ${isVideo(asset) ? 'video' : 'photo'}?`
                : 'Rename this file'}
            </h2>

            {action === 'delete' ? (
              <>
                <p className="xm-viewer__dialog-copy">
                  This removes it from the library. Your delete setting decides whether the
                  file in the photos folder is removed too.
                </p>
                {actionError ? (
                  <p className="xm-viewer__dialog-error" role="alert">
                    {actionError}
                  </p>
                ) : null}
                <div className="xm-viewer__dialog-actions">
                  <button
                    type="button"
                    className="xm-viewer__dialog-button"
                    disabled={working}
                    onClick={closeAction}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="xm-viewer__dialog-button xm-viewer__dialog-button--danger"
                    disabled={working}
                    onClick={() => void confirmDelete()}
                  >
                    {working ? 'Deleting…' : `Delete ${isVideo(asset) ? 'video' : 'photo'}`}
                  </button>
                </div>
              </>
            ) : (
              <form onSubmit={(event) => void submitRename(event)}>
                <label className="xm-viewer__dialog-label" htmlFor="xm-rename-input">
                  File name
                </label>
                <input
                  id="xm-rename-input"
                  className="xm-viewer__dialog-input"
                  value={renameValue}
                  autoFocus
                  disabled={working}
                  spellCheck={false}
                  onChange={(event) => setRenameValue(event.target.value)}
                />
                <p className="xm-viewer__dialog-hint">
                  The extension stays the same. This renames the file in your photos folder.
                </p>
                {actionError ? (
                  <p className="xm-viewer__dialog-error" role="alert">
                    {actionError}
                  </p>
                ) : null}
                <div className="xm-viewer__dialog-actions">
                  <button
                    type="button"
                    className="xm-viewer__dialog-button"
                    disabled={working}
                    onClick={closeAction}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="xm-viewer__dialog-button xm-viewer__dialog-button--primary"
                    disabled={working || !renameValue.trim()}
                  >
                    {working ? 'Renaming…' : 'Save name'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
