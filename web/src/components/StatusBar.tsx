import { formatBytes, formatCount } from '@xue-mint/shared';
import type { GalleryApiError, LibraryStatus } from '../api/types';
import { formatTimestamp } from '../lib/time';

export interface StatusBarProps {
  status: LibraryStatus | null;
  loading: boolean;
  error: GalleryApiError | null;
  onRetry: () => void;
}

/** Server-backed backup summary. Its failure never hides the photo grid. */
export function StatusBar({ status, loading, error, onRetry }: StatusBarProps) {
  return (
    <section className="statusbar" aria-label="Backup status">
      {status ? (
        <>
          <span className="statusbar__primary">
            {formatCount(status.photoCount, 'photo')} · {formatCount(status.videoCount, 'video')} ·{' '}
            {formatBytes(status.totalBytes)}
          </span>
          <span className="statusbar__item">
            {status.activeUploads === 0
              ? 'No uploads in progress'
              : formatCount(status.activeUploads, 'active upload')}
          </span>
          <span className="statusbar__item">
            Last added {formatTimestamp(status.lastActivityAt, 'nothing yet')}
          </span>
          <span className="statusbar__item">
            {formatCount(status.deviceCount, 'paired device')}
          </span>
        </>
      ) : loading ? (
        <span className="statusbar__item" role="status">
          Checking backup status…
        </span>
      ) : null}

      {error ? (
        <span className="statusbar__error" role="status">
          Backup status unavailable
          <button type="button" className="link-button" onClick={onRetry}>
            Retry
          </button>
        </span>
      ) : null}

      <span className="statusbar__mode">Stored on this PC</span>
    </section>
  );
}
