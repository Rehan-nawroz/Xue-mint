import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, TouchEvent } from 'react';
import { assetDate, formatDateTime } from '../dates';
import type { GalleryAsset } from '../types';
import { isVideo } from '../types';

export interface ViewerProps {
  assets: readonly GalleryAsset[];
  index: number;
  onClose: () => void;
  onIndexChange: (index: number) => void;
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
  swipeThreshold = 50,
}: ViewerProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const swipeStart = useRef<number | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
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
  }, [asset?.id]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
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
    </div>
  );
}
