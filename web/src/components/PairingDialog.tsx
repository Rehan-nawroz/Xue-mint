import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { GalleryApi, PairingInfo } from '../api/types';
import { toGalleryApiError } from '../api/types';

interface PairingDialogProps {
  api: GalleryApi;
  onClose: () => void;
}

function countdown(expiresAt: string | null, now: number): string {
  if (!expiresAt) return 'Single-use code';
  const remaining = Date.parse(expiresAt) - now;
  if (!Number.isFinite(remaining)) return 'Single-use code';
  if (remaining <= 0) return 'Code expired — create a new one';
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  return `Expires in ${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** One-time QR code for pairing a phone with the library on this PC. */
export function PairingDialog({ api, onClose }: PairingDialogProps) {
  const [code, setCode] = useState<PairingInfo | null>(null);
  const [qr, setQr] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setQr('');
    setCode(null);
    try {
      const next = await api.createPairingCode();
      if (!alive.current) return;
      setCode(next);
      setNow(Date.now());
      const svg = await QRCode.toString(JSON.stringify(next), {
        type: 'svg',
        width: 240,
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#000000', light: '#FFFFFF' },
      });
      if (alive.current) setQr(svg);
    } catch (caught) {
      if (!alive.current) return;
      setError(toGalleryApiError(caught).message);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  useEffect(() => {
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (!code?.expiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [code]);

  const expired = Boolean(code?.expiresAt && Date.parse(code.expiresAt) <= now);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="pairing-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pairing-dialog-title"
      >
        <header className="pairing-dialog__header">
          <div>
            <h2 id="pairing-dialog-title">Pair a phone</h2>
            <p>Scan this code with XueMint on your phone.</p>
          </div>
          <button
            ref={closeButton}
            type="button"
            className="modal-close"
            aria-label="Close pairing"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        {error ? (
          <div className="pairing-dialog__body pairing-dialog__body--message">
            <p className="notice notice--error" role="alert">
              {error}
            </p>
            <button type="button" className="secondary-button" onClick={() => void load()}>
              Try again
            </button>
          </div>
        ) : (
          <div className="pairing-dialog__body">
            <div className="pairing-dialog__qr">
              {loading || !qr ? (
                <div className="pairing-dialog__qr-placeholder" role="status">
                  <span className="xm-spinner" aria-hidden="true" />
                  Preparing a fresh code…
                </div>
              ) : (
                <div
                  className={expired ? 'pairing-qr is-expired' : 'pairing-qr'}
                  role="img"
                  aria-label="Pairing QR code"
                  dangerouslySetInnerHTML={{ __html: qr }}
                />
              )}
              <p className="pairing-dialog__countdown" aria-live="polite">
                {code ? countdown(code.expiresAt, now) : 'Single-use code'}
              </p>
            </div>

            <div className="pairing-dialog__copy">
              <ol className="pairing-steps">
                <li>Connect your phone to the same Wi-Fi as this PC.</li>
                <li>Open XueMint and scan the code.</li>
                <li>The code works once and expires after 10 minutes.</li>
              </ol>

              <dl className="pairing-details">
                <div>
                  <dt>This PC</dt>
                  <dd>{code?.serverName ?? '—'}</dd>
                </div>
                <div>
                  <dt>Address</dt>
                  <dd className="pairing-details__addresses">
                    {code
                      ? code.addresses.map((address) => (
                          <span key={address}>
                            https://{address}:{code.port}
                          </span>
                        ))
                      : '—'}
                  </dd>
                </div>
              </dl>

              <details className="pairing-fingerprint">
                <summary>Certificate fingerprint</summary>
                <code>{code?.fingerprint ?? '—'}</code>
                <p>Your phone remembers this value so it only trusts this PC.</p>
              </details>

              <div className="pairing-dialog__actions">
                <button
                  type="button"
                  className="primary-button"
                  disabled={loading}
                  onClick={() => void load()}
                >
                  {loading ? 'Preparing…' : 'New code'}
                </button>
                <button type="button" className="secondary-button" onClick={onClose}>
                  Done
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
