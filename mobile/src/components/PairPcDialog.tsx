import { useEffect, useRef, useState } from 'react';
import { DEMO_PAIRING_PAYLOAD } from '../engine';
import type { EngineMode } from '../engine';
import type { PairingScan } from '../engine/scanner';
import { startPairingScan } from '../engine/scanner';
import { CloseIcon, PairIcon, QrIcon } from './icons';

interface PairPcDialogProps {
  open: boolean;
  mode: EngineMode;
  onClose: () => void;
  onPair: (payload: string) => Promise<void>;
}

type Stage = 'idle' | 'manual' | 'scanning' | 'verifying';

export function PairPcDialog({ open, mode, onClose, onPair }: PairPcDialogProps) {
  const [payload, setPayload] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const scanRef = useRef<PairingScan | null>(null);
  const working = stage === 'verifying';

  useEffect(() => {
    if (!open) {
      // The scanned token lives only while the dialog is open.
      setPayload('');
      setError(null);
      setStage('idle');
      return;
    }
    setError(null);
    setStage('idle');
    setPayload(mode === 'mock' ? JSON.stringify(DEMO_PAIRING_PAYLOAD, null, 2) : '');
  }, [mode, open]);

  useEffect(() => {
    if (stage !== 'manual') return;
    const timer = window.setTimeout(() => textareaRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [stage]);

  useEffect(
    () => () => {
      void scanRef.current?.cancel();
    },
    []
  );

  if (!open) return null;

  const submit = async (raw: string) => {
    if (!raw.trim() || working) return;
    setStage('verifying');
    setError(null);
    try {
      await onPair(raw);
      setPayload('');
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStage('idle');
    }
  };

  const close = () => {
    void scanRef.current?.cancel();
    scanRef.current = null;
    setPayload('');
    setError(null);
    setStage('idle');
    onClose();
  };

  const scan = async () => {
    setError(null);
    setStage('scanning');
    try {
      const scanSession = await startPairingScan();
      scanRef.current = scanSession;
      const text = await scanSession.result;
      scanRef.current = null;
      setPayload(text);
      await submit(text);
    } catch (cause) {
      scanRef.current = null;
      setStage('manual');
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (stage === 'scanning') {
    return (
      <div className="pairing-scanner fixed inset-0 z-[200] flex flex-col items-center justify-between px-6 py-10">
        <p className="relative z-10 mt-6 max-w-[260px] text-center text-[14px] font-semibold text-white drop-shadow">
          Point the camera at the QR code on your PC
        </p>
        <div className="relative h-[230px] w-[230px]">
          <div className="h-full w-full rounded-2xl border-2 border-white/80 shadow-[0_0_0_100vmax_#000]" />
          <span className="absolute -left-0.5 -top-0.5 h-7 w-7 rounded-tl-2xl border-l-4 border-t-4 border-white" />
          <span className="absolute -right-0.5 -top-0.5 h-7 w-7 rounded-tr-2xl border-r-4 border-t-4 border-white" />
          <span className="absolute -bottom-0.5 -left-0.5 h-7 w-7 rounded-bl-2xl border-b-4 border-l-4 border-white" />
          <span className="absolute -bottom-0.5 -right-0.5 h-7 w-7 rounded-br-2xl border-b-4 border-r-4 border-white" />
        </div>
        <button
          type="button"
          className="relative z-10 mb-2 rounded-full bg-white/90 px-6 py-2.5 text-[13px] font-semibold text-[#141418]"
          onClick={close}
        >
          Cancel
        </button>
      </div>
    );
  }

  const manual = mode === 'native' && stage === 'manual';

  return (
    <div
      className="fixed inset-0 z-[150] grid place-items-center bg-black/55 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !working) close();
      }}
    >
      <div
        className="w-full max-w-[430px] rounded-2xl border border-line bg-surface shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pair-dialog-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !working) close();
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
            onClick={close}
            disabled={working}
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 px-4 py-4">
          {mode === 'mock' ? (
            <p className="rounded-xl bg-surface-2 px-3 py-2 text-[12px] leading-relaxed text-muted">
              The browser preview uses sample data. Scan the demo code or press Pair to connect
              to the simulated PC.
            </p>
          ) : manual ? (
            <p className="rounded-xl bg-surface-2 px-3 py-2 text-[12px] leading-relaxed text-muted">
              Type or paste the pairing code shown on the desktop QR screen.
            </p>
          ) : (
            <div className="rounded-xl border border-line px-3 py-4 text-center">
              <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-brand/10 text-brand">
                <QrIcon className="h-6 w-6" />
              </span>
              <p className="mt-2 text-[13px] font-semibold">Scan the code on your PC</p>
              <p className="mx-auto mt-1 max-w-[250px] text-[11px] leading-relaxed text-muted">
                Open the pairing window in the desktop app, then point your camera at the code.
              </p>
            </div>
          )}

          {(mode === 'mock' || manual) && (
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold text-muted">
                Pairing code
              </span>
              <textarea
                ref={textareaRef}
                className="h-32 w-full resize-none rounded-xl border border-line bg-app px-3 py-2 font-mono text-[11px] leading-relaxed text-ink outline-none focus:border-brand"
                value={payload}
                placeholder='{"serverName":"STUDIO-PC", ...}'
                spellCheck={false}
                disabled={working}
                onChange={(event) => setPayload(event.target.value)}
              />
            </label>
          )}

          {working ? (
            <p className="rounded-xl bg-surface-2 px-3 py-2 text-[12px] text-muted" role="status">
              Checking the certificate…
            </p>
          ) : null}

          {error ? (
            <p className="rounded-xl bg-danger-soft px-3 py-2 text-[12px] text-danger" role="alert">
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2 pt-1">
            {mode === 'native' && manual ? (
              <button
                type="button"
                className="mr-auto rounded-full border border-line px-3 py-2 text-[12px] font-semibold text-brand hover:bg-surface-2"
                onClick={() => {
                  setError(null);
                  setStage('idle');
                }}
                disabled={working}
              >
                Scan instead
              </button>
            ) : null}

            {mode === 'native' && !manual ? (
              <button
                type="button"
                className="mr-auto rounded-full border border-line px-3 py-2 text-[12px] font-semibold text-ink hover:bg-surface-2"
                onClick={() => setStage('manual')}
                disabled={working}
              >
                Enter code manually
              </button>
            ) : null}

            {mode === 'mock' ? (
              <button
                type="button"
                className="rounded-full border border-line px-4 py-2 text-[12px] font-semibold text-ink hover:bg-surface-2"
                onClick={() => void submit(JSON.stringify(DEMO_PAIRING_PAYLOAD))}
                disabled={working}
              >
                Simulate scan
              </button>
            ) : null}

            <button
              type="button"
              className="rounded-full border border-line px-4 py-2 text-[12px] font-semibold text-ink hover:bg-surface-2"
              onClick={close}
              disabled={working}
            >
              Cancel
            </button>

            {mode === 'native' && !manual ? (
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-full bg-brand px-4 py-2 text-[12px] font-semibold text-white disabled:opacity-50"
                onClick={() => void scan()}
                disabled={working}
              >
                <QrIcon className="h-4 w-4" />
                Scan QR code
              </button>
            ) : (
              <button
                type="button"
                className="rounded-full bg-brand px-4 py-2 text-[12px] font-semibold text-white disabled:opacity-50"
                onClick={() => void submit(payload)}
                disabled={working || !payload.trim()}
              >
                {working ? 'Pairing…' : 'Pair'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
