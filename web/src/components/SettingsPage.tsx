import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { EmptyState } from '@xue-mint/shared';
import type {
  ConnectionStatus,
  GalleryApi,
  GalleryApiError,
  ServerSettings,
} from '../api/types';
import { toGalleryApiError } from '../api/types';
import { ErrorPane } from './ErrorPane';
import { PairingDialog } from './PairingDialog';
import {
  formFromSettings,
  hasSettingsErrors,
  validateSettings,
} from '../lib/settings';
import type { SettingsForm, SettingsFormErrors } from '../lib/settings';

interface SettingsPageProps {
  api: GalleryApi;
}

/** Editable server settings with validation, persistence and restart guidance. */
export function SettingsPage({ api }: SettingsPageProps) {
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<GalleryApiError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<SettingsFormErrors>({});
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [connection, setConnection] = useState<ConnectionStatus | null>(null);
  const [connectionLoading, setConnectionLoading] = useState(true);
  const [connectionSaving, setConnectionSaving] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.fetchSettings();
      setSettings(next);
      setForm(formFromSettings(next));
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

  const loadConnection = useCallback(async () => {
    setConnectionLoading(true);
    try {
      setConnection(await api.fetchConnection());
      setConnectionError(null);
    } catch (caught) {
      setConnectionError(toGalleryApiError(caught).message);
    } finally {
      setConnectionLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadConnection();
  }, [loadConnection]);

  const toggleConnection = async () => {
    if (!connection || connectionSaving || !connection.canManage) return;
    setConnectionSaving(true);
    setConnectionError(null);
    setConnectionMessage(null);
    try {
      const next = await api.setConnection(!connection.allowed);
      setConnection(next);
      setConnectionMessage(
        next.allowed
          ? 'Phones on this Wi-Fi can now reach XueMint.'
          : 'New phone connections are blocked.'
      );
    } catch (caught) {
      setConnectionError(toGalleryApiError(caught).message);
    } finally {
      setConnectionSaving(false);
    }
  };

  const update = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) => {
    setForm((current) => (current ? { ...current, [key]: value } : current));
    setSaveMessage(null);
    setSaveError(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form) return;

    const errors = validateSettings(form);
    setFieldErrors(errors);
    if (hasSettingsErrors(errors)) return;

    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      const saved = await api.saveSettings({
        photosFolder: form.photosFolder.trim(),
        deleteBehavior: form.deleteBehavior,
        mirrorFolder: form.mirrorFolder.trim(),
        port: Number(form.port.trim()),
      });
      setSettings(saved);
      setForm(formFromSettings(saved));
      setFieldErrors({});
      setSaveMessage(
        saved.restartRequired
          ? 'Settings saved. The new folder and port take effect the next time the server starts; delete behavior applies immediately.'
          : 'Settings saved. Delete behavior applies immediately.'
      );
    } catch (caught) {
      const next = toGalleryApiError(caught);
      if (next.status === 400) setSaveError(next.message);
      else setError(next);
    } finally {
      setSaving(false);
    }
  };

  if (loading && !settings) {
    return <EmptyState busy title="Loading settings" />;
  }

  if (error) {
    return <ErrorPane error={error} onRetry={() => void load()} />;
  }

  if (!form || !settings) return null;

  return (
    <section className="page" aria-labelledby="settings-title">
      <div className="page__header">
        <div>
          <h2 id="settings-title">Settings</h2>
          <p className="page__hint">These values are stored on this PC.</p>
        </div>
      </div>

      {settings.restartRequired ? (
        <p className="notice notice--warning" role="status">
          Restart the server to use the saved port. The library is watching{' '}
          <strong>{settings.activePhotosFolder}</strong> on port{' '}
          <strong>{settings.activePort}</strong> until then.
        </p>
      ) : null}

      {saveMessage ? (
        <p className="notice notice--success" role="status">
          {saveMessage}
        </p>
      ) : null}
      {saveError ? (
        <p className="notice notice--error" role="alert">
          {saveError}
        </p>
      ) : null}

      <form className="settings-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="field">
          <label htmlFor="photos-folder">Photos folder</label>
          <input
            id="photos-folder"
            type="text"
            value={form.photosFolder}
            spellCheck={false}
            aria-invalid={Boolean(fieldErrors.photosFolder)}
            aria-describedby={
              fieldErrors.photosFolder ? 'photos-folder-error photos-folder-hint' : 'photos-folder-hint'
            }
            onChange={(event) => update('photosFolder', event.target.value)}
          />
          <p className="field__hint" id="photos-folder-hint">
            Full path of the folder the server watches. Changing it re-targets the
            watcher immediately and indexes files already in the folder.
          </p>
          {fieldErrors.photosFolder ? (
            <p className="field__error" id="photos-folder-error" role="alert">
              {fieldErrors.photosFolder}
            </p>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor="delete-behavior">When a photo is deleted</label>
          <select
            id="delete-behavior"
            value={form.deleteBehavior}
            onChange={(event) =>
              update('deleteBehavior', event.target.value as SettingsForm['deleteBehavior'])
            }
          >
            <option value="index_only">Remove from the library only (keep the file)</option>
            <option value="delete_file">Delete the file from the PC as well</option>
          </select>
          <p className="field__hint">
            Applies to deletions from now on. Deleting from the library never touches files
            unless you choose the second option.
          </p>
        </div>

        <div className="field">
          <label htmlFor="mirror-folder">Mirror folder (optional)</label>
          <input
            id="mirror-folder"
            type="text"
            value={form.mirrorFolder}
            spellCheck={false}
            placeholder="E:\\PhotoBackup"
            aria-invalid={Boolean(fieldErrors.mirrorFolder)}
            aria-describedby={
              fieldErrors.mirrorFolder ? 'mirror-folder-error mirror-folder-hint' : 'mirror-folder-hint'
            }
            onChange={(event) => update('mirrorFolder', event.target.value)}
          />
          <p className="field__hint" id="mirror-folder-hint">
            Keeps a second copy of every photo in another folder or on an external
            drive. Leave it empty to keep one copy. Existing photos are copied
            when you save a new mirror folder.
          </p>
          {settings.mirrorFolder && !settings.mirrorAvailable ? (
            <p className="notice notice--warning" role="status">
              The mirror folder is not reachable right now. New photos are saved on
              this PC only until that drive is connected again.
            </p>
          ) : null}
          {fieldErrors.mirrorFolder ? (
            <p className="field__error" id="mirror-folder-error" role="alert">
              {fieldErrors.mirrorFolder}
            </p>
          ) : null}
        </div>

        <div className="field field--short">
          <label htmlFor="port">Server port</label>
          <input
            id="port"
            type="text"
            inputMode="numeric"
            value={form.port}
            aria-invalid={Boolean(fieldErrors.port)}
            aria-describedby={fieldErrors.port ? 'port-error port-hint' : 'port-hint'}
            onChange={(event) => update('port', event.target.value)}
          />
          <p className="field__hint" id="port-hint">
            Between 1024 and 65535. Changing the port requires a server restart.
          </p>
          {fieldErrors.port ? (
            <p className="field__error" id="port-error" role="alert">
              {fieldErrors.port}
            </p>
          ) : null}
        </div>

        <div className="settings-form__active">
          <h3>Active now</h3>
          <p>
            Folder: <code>{settings.activePhotosFolder}</code>
          </p>
          <p>
            Port: <code>{settings.activePort}</code>
          </p>
        </div>

        <button type="submit" className="primary-button" disabled={saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </form>

      <section className="connection-panel" aria-labelledby="phone-connections-title">
        <div className="connection-panel__copy">
          <h3 id="phone-connections-title">Phone connections</h3>
          <p>
            Let phones on this Wi-Fi reach XueMint. Windows Firewall controls access on
            private networks; the internet stays blocked.
          </p>
          <p className="connection-panel__state" role="status">
            <span
              className={
                connection?.allowed
                  ? 'connection-panel__dot is-allowed'
                  : 'connection-panel__dot'
              }
              aria-hidden="true"
            />
            {connectionLoading
              ? 'Checking Windows Firewall…'
              : !connection
                ? 'Connection status unavailable'
                : !connection.canManage
                  ? 'Available on Windows only'
                  : connection.allowed
                    ? 'Phones on this Wi-Fi can connect'
                    : 'Phone connections are blocked'}
          </p>
          {connectionError ? (
            <p className="connection-panel__message field__error" role="alert">
              {connectionError}
              <button type="button" className="link-button" onClick={() => void loadConnection()}>
                Try again
              </button>
            </p>
          ) : null}
          {connectionMessage ? (
            <p className="connection-panel__message" role="status">
              {connectionMessage}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className={
            connection?.allowed ? 'danger-outline-button' : 'secondary-button'
          }
          disabled={connectionLoading || connectionSaving || !connection?.canManage}
          onClick={() => void toggleConnection()}
        >
          {connectionSaving
            ? 'Waiting for Windows…'
            : connection?.allowed
              ? 'Block phone connections'
              : 'Allow phone connections'}
        </button>
      </section>

      <section className="pairing-panel" aria-labelledby="pair-phone-title">
        <div>
          <h3 id="pair-phone-title">Pair a phone</h3>
          <p>
            Show a one-time QR code for the XueMint app. Allow phone connections above
            first, then scan with your phone over this Wi-Fi.
          </p>
        </div>
        <button
          type="button"
          className="secondary-button"
          onClick={() => setPairingOpen(true)}
        >
          Show QR code
        </button>
      </section>

      <FactoryResetPanel api={api} />

      {pairingOpen ? (
        <PairingDialog api={api} onClose={() => setPairingOpen(false)} />
      ) : null}
    </section>
  );
}

/** Wipes the server's library, thumbnails, pairing tokens and devices. */
function FactoryResetPanel({ api }: { api: GalleryApi }) {
  const [confirming, setConfirming] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(true);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetMessage, setResetMessage] = useState<string | null>(null);

  const runReset = useCallback(async () => {
    setResetting(true);
    setResetError(null);
    setResetMessage(null);
    try {
      const result = await api.factoryReset({ deleteFiles });
      setResetMessage(
        result.filesRemoved > 0
          ? `Reset done — ${result.filesRemoved} file(s) removed from the watched folder.`
          : 'Reset done — the library is empty.'
      );
      setConfirming(false);
    } catch (caught) {
      setResetError(caught instanceof Error ? caught.message : 'Reset failed.');
    } finally {
      setResetting(false);
    }
  }, [api, deleteFiles]);

  return (
    <section className="pairing-panel" aria-labelledby="factory-reset-title">
      <div>
        <h3 id="factory-reset-title">Factory reset</h3>
        <p>
          Removes every photo from this PC's library: the index, thumbnails,
          pairing tokens and all paired phones. Your settings stay. Nothing is
          sent anywhere.
        </p>
      </div>
      {!confirming ? (
        <button
          type="button"
          className="danger-outline-button"
          onClick={() => setConfirming(true)}
        >
          Reset library…
        </button>
      ) : (
        <div className="factory-reset-confirm">
          <label className="factory-reset-confirm__check">
            <input
              type="checkbox"
              checked={deleteFiles}
              onChange={(event) => setDeleteFiles(event.target.checked)}
            />
            Also delete the photo files stored in the watched folder
          </label>
          <p className="factory-reset-confirm__warn" role="status">
            {deleteFiles
              ? 'This permanently deletes the files inside the watched folder. Copy them out first if you need them.'
              : "Photo files stay in the watched folder; only this PC's library is emptied."}
          </p>
          <div className="factory-reset-confirm__actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={resetting}
              onClick={() => void runReset()}
            >
              {resetting ? 'Resetting…' : 'Erase everything'}
            </button>
          </div>
          {resetError ? (
            <p role="alert" className="factory-reset-confirm__error">
              {resetError}
            </p>
          ) : null}
        </div>
      )}
      {resetMessage ? (
        <p role="status" className="factory-reset-confirm__done">
          {resetMessage}
        </p>
      ) : null}
    </section>
  );
}
