import { useCallback, useEffect, useState } from 'react';
import { EmptyState, formatDateTime, toDate } from '@xue-mint/shared';
import type { GalleryApiError, GalleryApi, PairedDevice } from '../api/types';
import { isAuthError, toGalleryApiError } from '../api/types';
import { ErrorPane } from './ErrorPane';

interface DevicesPageProps {
  api: GalleryApi;
}

function pairedLabel(value: string): string {
  const date = toDate(value);
  return date ? formatDateTime(date) : 'Unknown';
}

/** Paired phone management: list, confirm, revoke, and report the result. */
export function DevicesPage({ api }: DevicesPageProps) {
  const [devices, setDevices] = useState<PairedDevice[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<GalleryApiError | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.fetchDevices();
      setDevices(next);
      setError(null);
    } catch (caught) {
      setError(toGalleryApiError(caught));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (device: PairedDevice) => {
    setBusyId(device.id);
    setActionError(null);
    try {
      await api.revokeDevice(device.id);
      setPendingId(null);
      setNotice(`${device.name} was revoked and can no longer open this library.`);
      await load();
    } catch (caught) {
      const next = toGalleryApiError(caught);
      if (isAuthError(next)) setError(next);
      else setActionError(next.message);
    } finally {
      setBusyId(null);
    }
  };

  if (loading && !devices) {
    return <EmptyState busy title="Loading paired devices" />;
  }

  if (error) {
    return <ErrorPane error={error} onRetry={() => void load()} />;
  }

  if (!devices || devices.length === 0) {
    return (
      <EmptyState
        title="No devices paired yet"
        description="Pair your phone from the desktop app. Paired phones can back up photos to this PC and browse the library."
        actionLabel="Refresh"
        onAction={() => void load()}
      />
    );
  }

  return (
    <section className="page" aria-labelledby="devices-title">
      <div className="page__header">
        <div>
          <h2 id="devices-title">Paired devices</h2>
          <p className="page__hint">
            Revoking a device immediately blocks it. Backed-up photos stay on this PC.
          </p>
        </div>
        <button type="button" className="secondary-button" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      {notice ? (
        <p className="notice notice--success" role="status">
          {notice}
        </p>
      ) : null}
      {actionError ? (
        <p className="notice notice--error" role="alert">
          {actionError}
        </p>
      ) : null}

      <ul className="device-list">
        {devices.map((device) => (
          <li key={device.id} className="device-card">
            <div className="device-card__main">
              <div>
                <h3 className="device-card__name">{device.name}</h3>
                <p className="device-card__meta">
                  Paired {pairedLabel(device.pairedAt)} · Last seen{' '}
                  {device.lastSeenAt ? pairedLabel(device.lastSeenAt) : 'never'}
                </p>
              </div>
              <span
                className={
                  device.revoked ? 'badge badge--muted' : 'badge badge--success'
                }
              >
                {device.revoked ? 'Revoked' : 'Active'}
              </span>
            </div>

            {device.revoked ? (
              <p className="device-card__revoked">
                This device can no longer open the library. Pair it again to restore access.
              </p>
            ) : pendingId === device.id ? (
              <div
                className="device-card__confirm"
                role="group"
                aria-label={`Confirm revoking ${device.name}`}
              >
                <p>Revoke {device.name}? It will need to be paired again.</p>
                <button
                  type="button"
                  className="danger-button"
                  disabled={busyId === device.id}
                  onClick={() => void revoke(device)}
                >
                  {busyId === device.id ? 'Revoking…' : 'Yes, revoke'}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setPendingId(null)}
                  disabled={busyId === device.id}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="danger-outline-button"
                onClick={() => {
                  setNotice(null);
                  setActionError(null);
                  setPendingId(device.id);
                }}
              >
                Revoke access
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
