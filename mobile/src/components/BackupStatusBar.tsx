import type { BackupStatus } from '../engine';
import { AlertIcon, CheckCircleIcon, CloudIcon, CloudOffIcon, PairIcon } from './icons';

interface BackupStatusBarProps {
  status: BackupStatus | null;
  loading: boolean;
  error: string | null;
  onPair: () => void;
  onRetry: () => void;
}

interface Presentation {
  title: string;
  detail: string;
  tone: 'ok' | 'pending' | 'offline' | 'error' | 'pair';
}

function present(status: BackupStatus): Presentation {
  if (status.connection === 'unreachable') {
    return {
      title: 'PC not reachable',
      detail: "Will back up when you're home",
      tone: 'offline',
    };
  }
  if (status.connection === 'not_paired') {
    return {
      title: 'Back up to your PC',
      detail: 'Pair once to get started',
      tone: 'pair',
    };
  }
  if (status.connection === 'error') {
    return {
      title: 'Backup needs attention',
      detail: status.message,
      tone: 'error',
    };
  }
  if (status.phase === 'uploading') {
    return {
      title: status.currentPhoto ? `Backing up ${status.currentPhoto}` : 'Backing up',
      detail:
        status.totalBytes > 0
          ? `${Math.max(0, status.pending)} photos left in the queue`
          : 'Sending photos to your PC',
      tone: 'pending',
    };
  }
  if (status.pending > 0) {
    return {
      title: `${status.pending} ${status.pending === 1 ? 'photo' : 'photos'} waiting to back up`,
      detail: 'Over Wi-Fi when your PC is available',
      tone: 'pending',
    };
  }
  return {
    title: 'Backup complete',
    detail: 'All photos are on your PC',
    tone: 'ok',
  };
}

function StatusIcon({ tone }: { tone: Presentation['tone'] }) {
  const className = 'h-[18px] w-[18px]';
  if (tone === 'ok') return <CheckCircleIcon className={className} />;
  if (tone === 'offline') return <CloudOffIcon className={className} />;
  if (tone === 'error') return <AlertIcon className={className} />;
  if (tone === 'pair') return <PairIcon className={className} />;
  return <CloudIcon className={className} />;
}

export function BackupStatusBar({
  status,
  loading,
  error,
  onPair,
  onRetry,
}: BackupStatusBarProps) {
  if (loading && !status) {
    return (
      <div
        className="flex items-center gap-2 border-b border-line bg-surface px-4 py-2 text-[12px] text-muted"
        role="status"
      >
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line border-t-brand" />
        Checking backup status…
      </div>
    );
  }

  if (!status || error) {
    return (
      <div
        className="flex items-center gap-2 border-b border-line bg-surface px-4 py-2 text-[12px] text-danger"
        role="alert"
      >
        <AlertIcon className="h-4 w-4" />
        <span className="min-w-0 flex-1 truncate">{error ?? 'Backup status unavailable'}</span>
        <button
          type="button"
          className="rounded-full px-2 py-1 font-semibold text-brand"
          onClick={onRetry}
        >
          Retry
        </button>
      </div>
    );
  }

  const view = present(status);
  const progress =
    status.phase === 'uploading' && status.totalBytes > 0
      ? Math.min(100, Math.round((status.uploadedBytes / status.totalBytes) * 100))
      : null;
  const toneClasses =
    view.tone === 'offline' || view.tone === 'error'
      ? 'bg-warning-soft text-ink'
      : view.tone === 'pair'
        ? 'bg-brand/10 text-brand'
        : 'bg-surface text-ink';

  return (
    <div
      className={`flex items-center gap-3 border-b border-line px-4 py-2 ${toneClasses}`}
      role="status"
      data-testid="backup-status"
    >
      <span
        className={`flex h-8 w-8 flex-none items-center justify-center rounded-full ${
          view.tone === 'ok'
            ? 'bg-success-soft text-success'
            : view.tone === 'offline'
              ? 'bg-surface text-muted'
              : view.tone === 'error'
                ? 'bg-danger-soft text-danger'
                : 'bg-surface-2 text-brand'
        }`}
      >
        <StatusIcon tone={view.tone} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px] font-semibold leading-tight">{view.title}</p>
        <p className="truncate text-[11px] leading-tight text-muted">{view.detail}</p>
        {progress !== null ? (
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line" aria-hidden="true">
            <div
              className="h-full rounded-full bg-brand transition-[width]"
              style={{ width: `${progress}%` }}
            />
          </div>
        ) : null}
      </div>
      {view.tone === 'pair' ? (
        <button
          type="button"
          className="flex-none rounded-full bg-brand px-3 py-1.5 text-[11px] font-semibold text-white"
          onClick={onPair}
        >
          Pair
        </button>
      ) : null}
    </div>
  );
}
