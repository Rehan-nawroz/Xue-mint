import type { ReactNode } from 'react';
import type { BackupStatus, EngineMode } from '../engine';
import { CheckCircleIcon, CloudIcon, PhoneIcon, SearchIcon } from '../components/icons';

interface LibraryScreenProps {
  status: BackupStatus | null;
  mode: EngineMode;
  onPair: () => void;
}

function StatCard({
  title,
  value,
  detail,
  icon,
  tone = 'neutral',
}: {
  title: string;
  value: string;
  detail: string;
  icon: ReactNode;
  tone?: 'neutral' | 'ok' | 'warn';
}) {
  const toneClass =
    tone === 'ok'
      ? 'bg-success-soft text-success'
      : tone === 'warn'
        ? 'bg-warning-soft text-ink'
        : 'bg-surface-2 text-brand';
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</p>
          <p className="mt-1 text-[22px] font-bold leading-none">{value}</p>
        </div>
        <span className={`flex h-9 w-9 items-center justify-center rounded-full ${toneClass}`}>
          {icon}
        </span>
      </div>
      <p className="mt-2 text-[12px] leading-snug text-muted">{detail}</p>
    </div>
  );
}

export function LibraryScreen({ status, mode, onPair }: LibraryScreenProps) {
  const phonePhotos = status?.phonePhotos ?? 0;
  const backedUp = status?.backedUp ?? 0;
  const pending = status?.pending ?? 0;
  const progress = phonePhotos > 0 ? Math.round((backedUp / phonePhotos) * 100) : 0;

  return (
    <div className="screen-scroll min-h-0 flex-1 overflow-y-auto bg-app">
      <div className="safe-top px-4 pb-2 pt-3">
        <h1 className="text-[23px] font-bold tracking-tight">Library</h1>
        <p className="text-[11px] text-muted">What is on this phone and your PC</p>
      </div>

      <div className="space-y-3 px-4 pb-6">
        <div className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
          <div className="flex items-center gap-2">
            <PhoneIcon className="h-4 w-4 text-brand" />
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
            <span>{pending} waiting</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <StatCard
            title="Backup queue"
            value={String(pending)}
            detail={pending === 0 ? 'Nothing waiting to upload' : 'Will send when your PC is reachable'}
            icon={<CloudIcon className="h-4 w-4" />}
            tone={pending === 0 ? 'ok' : 'neutral'}
          />
          <StatCard
            title="Last backup"
            value={status?.lastBackupAt ? 'Recent' : '—'}
            detail={status?.lastBackupAt ? 'Photos are up to date' : 'No backup has run yet'}
            icon={<CheckCircleIcon className="h-4 w-4" />}
            tone={status?.lastBackupAt ? 'ok' : 'warn'}
          />
        </div>

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
    </div>
  );
}
