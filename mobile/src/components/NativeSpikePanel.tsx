import { useState } from 'react';
import type { NativeDiagnostics } from '../engine';

interface LogEntry {
  id: number;
  title: string;
  ok: boolean;
  detail: string;
}

interface NativeSpikePanelProps {
  diagnostics: NativeDiagnostics;
}

function formatError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function NativeSpikePanel({ diagnostics }: NativeSpikePanelProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [address, setAddress] = useState('192.168.1.5');
  const [port, setPort] = useState('8427');
  const [fingerprint, setFingerprint] = useState('');
  const [discovered, setDiscovered] = useState<string | null>(null);

  const append = (title: string, ok: boolean, detail: string) => {
    setLog((entries) => [
      { id: Date.now() + Math.random(), title, ok, detail },
      ...entries,
    ]);
  };

  const run = async (id: string, title: string, task: () => Promise<string>) => {
    if (busy) return;
    setBusy(id);
    try {
      const detail = await task();
      append(title, true, detail);
    } catch (cause) {
      append(title, false, formatError(cause));
    } finally {
      setBusy(null);
    }
  };

  const portNumber = Number.parseInt(port, 10);

  return (
    <section className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-semibold">Native spike checks</h2>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            Runs on the Android build only. These prove the four riskiest pieces against your
            real desktop.
          </p>
        </div>
        <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[10px] font-semibold text-ink">
          Debug
        </span>
      </div>

      <div className="mt-3 grid gap-2">
        <button
          type="button"
          data-testid="spike-ping"
          className="flex items-center justify-between rounded-xl border border-line px-3 py-2 text-left text-[12px] font-semibold hover:bg-surface-2 disabled:opacity-50"
          disabled={busy !== null}
          onClick={() =>
            void run('ping', 'Kotlin plugin ping', async () => {
              const result = await diagnostics.ping();
              return `${result.message} (Android SDK ${result.sdk})`;
            })
          }
        >
          <span>Ping the Kotlin plugin</span>
          <span className="text-[10px] font-medium text-muted">
            {busy === 'ping' ? 'Running…' : 'WebView → Kotlin → back'}
          </span>
        </button>

        <button
          type="button"
          data-testid="spike-media"
          className="flex items-center justify-between rounded-xl border border-line px-3 py-2 text-left text-[12px] font-semibold hover:bg-surface-2 disabled:opacity-50"
          disabled={busy !== null}
          onClick={() =>
            void run('media', 'MediaStore scan', async () => {
              const granted = await diagnostics.requestMediaPermission();
              if (!granted) throw new Error('Photo access was not granted.');
              const result = await diagnostics.scanMediaStore(8);
              const sample = result.photos
                .slice(0, 3)
                .map((photo) => `${photo.filename} · ${photo.takenAt.slice(0, 10)}`)
                .join('\n');
              return `${result.count} photos visible in the library${
                sample ? `\n${sample}` : ''
              }`;
            })
          }
        >
          <span>Scan phone photos (MediaStore)</span>
          <span className="text-[10px] font-medium text-muted">
            {busy === 'media' ? 'Running…' : 'Permission + query'}
          </span>
        </button>

        <button
          type="button"
          data-testid="spike-mdns"
          className="flex items-center justify-between rounded-xl border border-line px-3 py-2 text-left text-[12px] font-semibold hover:bg-surface-2 disabled:opacity-50"
          disabled={busy !== null}
          onClick={() =>
            void run('mdns', 'mDNS discovery', async () => {
              const services = await diagnostics.discoverPc(6000);
              if (services.length === 0) {
                setDiscovered(null);
                throw new Error(
                  'No _xue-mint._tcp service found. Check that the desktop app is running on the same Wi-Fi.'
                );
              }
              const first = services[0];
              const address = first.addresses[0];
              if (address) setAddress(address);
              if (first.port > 0) setPort(String(first.port));
              if (first.fingerprint) setFingerprint(first.fingerprint);
              setDiscovered(JSON.stringify(services, null, 2));
              return services
                .map(
                  (service) =>
                    `${service.name} · ${service.addresses[0] ?? 'no address'}:${service.port}`
                )
                .join('\n');
            })
          }
        >
          <span>Find the desktop (mDNS)</span>
          <span className="text-[10px] font-medium text-muted">
            {busy === 'mdns' ? 'Searching…' : '6 second browse'}
          </span>
        </button>

        <div className="rounded-xl border border-line p-3">
          <p className="text-[12px] font-semibold">Pinned TLS handshake</p>
          <div className="mt-2 grid grid-cols-[1fr_80px] gap-2">
            <label className="block">
              <span className="mb-1 block text-[10px] font-semibold text-muted">PC address</span>
              <input
                className="w-full rounded-lg border border-line bg-app px-2 py-1.5 font-mono text-[11px] outline-none focus:border-brand"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                spellCheck={false}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] font-semibold text-muted">Port</span>
              <input
                className="w-full rounded-lg border border-line bg-app px-2 py-1.5 font-mono text-[11px] outline-none focus:border-brand"
                value={port}
                inputMode="numeric"
                onChange={(event) => setPort(event.target.value)}
              />
            </label>
          </div>
          <label className="mt-2 block">
            <span className="mb-1 block text-[10px] font-semibold text-muted">
              Certificate SHA-256 fingerprint (from the desktop QR)
            </span>
            <textarea
              className="h-16 w-full resize-none rounded-lg border border-line bg-app px-2 py-1.5 font-mono text-[10px] leading-relaxed outline-none focus:border-brand"
              value={fingerprint}
              placeholder="AA:BB:CC:…"
              spellCheck={false}
              onChange={(event) => setFingerprint(event.target.value)}
            />
          </label>
          <button
            type="button"
            data-testid="spike-tls"
            className="mt-2 w-full rounded-xl bg-brand px-3 py-2 text-[12px] font-semibold text-white disabled:opacity-50"
            disabled={busy !== null || !address.trim() || !fingerprint.trim()}
            onClick={() =>
              void run('tls', 'Pinned TLS handshake', async () => {
                if (!Number.isFinite(portNumber)) throw new Error('Enter a valid port.');
                const result = await diagnostics.probeTls(
                  address.trim(),
                  portNumber,
                  fingerprint.trim()
                );
                if (!result.ok) throw new Error(result.message);
                return `${result.message} (HTTP ${result.httpStatus ?? 'none'})`;
              })
            }
          >
            {busy === 'tls' ? 'Connecting…' : 'Test pinned TLS'}
          </button>
        </div>

        <div className="rounded-xl border border-line p-3">
          <p className="text-[12px] font-semibold">WorkManager background job</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              data-testid="spike-work-queue"
              className="flex-1 rounded-xl border border-line px-3 py-2 text-[12px] font-semibold hover:bg-surface-2 disabled:opacity-50"
              disabled={busy !== null}
              onClick={() =>
                void run('work', 'WorkManager job queued', async () => {
                  const result = await diagnostics.scheduleWorkProbe();
                  return `Work ID ${result.workId}`;
                })
              }
            >
              Queue probe
            </button>
            <button
              type="button"
              data-testid="spike-work-status"
              className="flex-1 rounded-xl border border-line px-3 py-2 text-[12px] font-semibold hover:bg-surface-2 disabled:opacity-50"
              disabled={busy !== null}
              onClick={() =>
                void run('work-status', 'WorkManager status', async () => {
                  const result = await diagnostics.workProbeStatus();
                  return `${result.state}${result.message ? ` · ${result.message}` : ''}`;
                })
              }
            >
              Refresh status
            </button>
          </div>
        </div>
      </div>

      {discovered ? (
        <details className="mt-3 rounded-xl bg-surface-2 p-2">
          <summary className="cursor-pointer text-[11px] font-semibold text-brand">
            Discovered services
          </summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[10px] leading-relaxed text-muted">
            {discovered}
          </pre>
        </details>
      ) : null}

      <div className="mt-3 space-y-2" aria-live="polite">
        {log.length === 0 ? (
          <p className="text-[11px] text-muted">No checks run yet.</p>
        ) : (
          log.map((entry) => (
            <div
              key={entry.id}
              className={`rounded-xl px-3 py-2 ${
                entry.ok ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'
              }`}
            >
              <p className="text-[11px] font-semibold">
                {entry.ok ? 'Passed' : 'Failed'} · {entry.title}
              </p>
              <pre className="mt-1 whitespace-pre-wrap break-words text-[10px] leading-relaxed">
                {entry.detail}
              </pre>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
