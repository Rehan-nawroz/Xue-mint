import { useEffect, useRef, useState } from 'react';
import { DEMO_PAIRING_PAYLOAD } from '../engine';
import type { EngineMode } from '../engine';
import { CloseIcon, PairIcon } from './icons';

interface PairPcDialogProps {
  open: boolean;
  mode: EngineMode;
  onClose: () => void;
  onPair: (payload: string) => Promise<void>;
}

export function PairPcDialog({ open, mode, onClose, onPair }: PairPcDialogProps) {
  const [payload, setPayload] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setWorking(false);
    setPayload(
      mode === 'mock' ? JSON.stringify(DEMO_PAIRING_PAYLOAD, null, 2) : ''
    );
    const timer = window.setTimeout(() => textareaRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [mode, open]);

  if (!open) return null;

  const submit = async () => {
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      await onPair(payload);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[150] grid place-items-center bg-black/55 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !working) onClose();
      }}
    >
      <div
        className="w-full max-w-[430px] rounded-2xl border border-line bg-surface shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pair-dialog-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !working) onClose();
        }}
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand/10 text-brand">
              <PairIcon className="h-[18px] w-[18px]" />
            </span>
            <div>
              <h2 id="pair-dialog-title" className="text-[15px] font-semibold">
                Pair with your PC
              </h2>
              <p className="text-[11px] text-muted">One-time code from the desktop app</p>
            </div>
          </div>
          <button
            type="button"
            className="flex h-8 w-8 flex-none items-center justify-center rounded-full text-muted hover:bg-surface-2"
            aria-label="Close pairing"
            onClick={onClose}
            disabled={working}
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 px-4 py-4">
          {mode === 'native' ? (
            <p className="rounded-xl bg-warning-soft px-3 py-2 text-[12px] leading-relaxed text-ink">
              Camera scanning is not part of this build yet. The native spike checks in
              Settings verify the connection pieces before pairing is added.
            </p>
          ) : (
            <p className="rounded-xl bg-surface-2 px-3 py-2 text-[12px] leading-relaxed text-muted">
              The browser preview uses sample data. A demo pairing code is filled in for you;
              press Pair to connect to the simulated PC.
            </p>
          )}

          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-muted">Pairing code</span>
            <textarea
              ref={textareaRef}
              className="h-36 w-full resize-none rounded-xl border border-line bg-app px-3 py-2 font-mono text-[11px] leading-relaxed text-ink outline-none focus:border-brand"
              value={payload}
              placeholder='{"serverName":"STUDIO-PC", ...}'
              spellCheck={false}
              disabled={working || mode === 'native'}
              onChange={(event) => setPayload(event.target.value)}
            />
          </label>

          {error ? (
            <p className="rounded-xl bg-danger-soft px-3 py-2 text-[12px] text-danger" role="alert">
              {error}
            </p>
          ) : null}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              className="rounded-full border border-line px-4 py-2 text-[12px] font-semibold text-ink hover:bg-surface-2"
              onClick={onClose}
              disabled={working}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-full bg-brand px-4 py-2 text-[12px] font-semibold text-white disabled:opacity-50"
              onClick={() => void submit()}
              disabled={working || mode === 'native' || !payload.trim()}
            >
              {working ? 'Pairing…' : 'Pair'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
