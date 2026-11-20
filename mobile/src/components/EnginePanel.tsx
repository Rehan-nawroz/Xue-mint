import { useCallback, useEffect, useState } from 'react';
import type { BackupEngine, PhonePhotoState } from '../engine';
import { formatDateTime } from '@xue-mint/shared';

interface EnginePanelProps {
  engine: BackupEngine;
}

const STATE_LABELS: Record<PhonePhotoState['state'], string> = {
  new: 'Not checked yet',
  hashed: 'Hashed',
  missing: 'Waiting to upload',
  uploading: 'Uploading',
  backedUp: 'Backed up',
  failed: 'Failed',
};

const STATE_CLASSES: Record<PhonePhotoState['state'], string> = {
  new: 'bg-surface-2 text-muted',
  hashed: 'bg-surface-2 text-muted',
  missing: 'bg-warning-soft text-ink',
  uploading: 'bg-brand/10 text-brand',
  backedUp: 'bg-success-soft text-success',
  failed: 'bg-danger-soft text-danger',
};

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * The engine debug surface: what the native backup actually did. Shows the
 * phone library through the engine with each photo's remembered backup state,
 * the counters, and the buttons that drive a pass.
 */
export function EnginePanel({ engine }: EnginePanelProps) {
  const [photos, setPhotos] = useState<PhonePhotoState[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const states = await engine.photoStates(30);
      setPhotos(states);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [engine]);

  useEffect(() => {
    void refresh();
    // Follow live progress while a pass runs, then refresh the list once.
    const unsubscribe = engine.subscribe((status) => {
      const active = status.phase !== 'idle';
      setRunning(active);
      if (!active) void refresh();
    });
    return () => {
      unsubscribe();
    };
  }, [engine, refresh]);

  const start = async () => {
    if (busy) return;
    setBusy('backup');
    setResult(null);
    try {
      const status = await engine.startBackup();
      setResult(status.message);
      setRunning(status.phase !== 'idle');
      await refresh();
    } catch (cause) {
      setResult(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const queueBackground = async () => {
    if (busy) return;
    setBusy('work');
    setResult(null);
    try {
      if (!engine.scheduleBackgroundBackup) {
        throw new Error('Background scheduling is Android-only.');
      }
      const outcome = await engine.scheduleBackgroundBackup();
      setResult(
        outcome.enqueued
          ? `Background backup queued · ${outcome.pending} photos pending` +
              (outcome.workState ? ` · work ${outcome.workState}` : '')
          : `Nothing to queue · ${outcome.pending} photos pending`
      );
    } catch (cause) {
      setResult(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-semibold">Backup engine</h2>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            What the engine remembers: every photo, its digest state and what
            the PC already has.
          </p>
        </div>
        <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[10px] font-semibold text-ink">
          Debug
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="engine-start-backup"
          className="flex-1 rounded-xl bg-brand px-3 py-2 text-[12px] font-semibold text-white disabled:opacity-50"
          disabled={busy !== null}
          onClick={() => void start()}
        >
          {busy === 'backup' ? 'Starting…' : running ? 'Back up now (running…)' : 'Back up now'}
        </button>
        <button
          type="button"
          data-testid="engine-refresh"
          className="rounded-xl border border-line px-3 py-2 text-[12px] font-semibold hover:bg-surface-2 disabled:opacity-50"
          disabled={busy !== null}
          onClick={() => void refresh()}
        >
          {busy === 'list' ? 'Reading…' : 'Refresh'}
        </button>
      </div>

      {result ? (
        <p
          className="mt-2 rounded-xl bg-surface-2 px-3 py-2 text-[11px] leading-relaxed"
          role="status"
        >
          {result}
        </p>
      ) : null}
      {error ? (
        <p className="mt-2 rounded-xl bg-danger-soft px-3 py-2 text-[11px] text-danger" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-3" data-testid="engine-photo-list">
        {photos === null ? (
          <p className="text-[11px] text-muted">Reading the engine library…</p>
        ) : photos.length === 0 ? (
          <p className="text-[11px] text-muted">
            The engine has not scanned the library yet. Run a backup first.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {photos.map((item) => (
              <li key={item.photo.id} className="flex items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-semibold leading-tight">
                    {item.photo.filename}
                  </p>
                  <p className="text-[10px] text-muted">
                    {formatDateTime(new Date(item.photo.takenAt))} ·{' '}
                    {formatBytes(item.photo.size)}
                    {item.error ? ` · ${item.error}` : ''}
                  </p>
                </div>
                <span
                  className={`flex-none rounded-full px-2 py-0.5 text-[9.5px] font-semibold ${
                    STATE_CLASSES[item.state]
                  }`}
                >
                  {STATE_LABELS[item.state]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <button
        type="button"
        className="mt-3 w-full rounded-xl border border-line px-3 py-2 text-[11px] font-semibold hover:bg-surface-2 disabled:opacity-50"
        disabled={busy !== null}
        onClick={() => void queueBackground()}
      >
        {busy === 'work' ? 'Queueing…' : 'Queue background backup (WorkManager)'}
      </button>
    </section>
  );
}
