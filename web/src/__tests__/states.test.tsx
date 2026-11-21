import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DevicesPage } from '../components/DevicesPage';
import { SettingsPage } from '../components/SettingsPage';
import { StatusBar } from '../components/StatusBar';
import { GalleryApiError } from '../api/types';
import {
  defaultConnection,
  defaultPairing,
  defaultSettings,
  defaultStatus,
  makeApi,
  makeDevice,
} from '../test/fixtures';

describe('StatusBar', () => {
  it('shows library totals from the server', () => {
    render(
      <StatusBar status={defaultStatus} loading={false} error={null} onRetry={() => undefined} />
    );
    expect(screen.getByText(/1 photo · 1 video · 2\.0 KB/)).toBeInTheDocument();
    expect(screen.getByText('No uploads in progress')).toBeInTheDocument();
    expect(screen.getByText('1 paired device')).toBeInTheDocument();
  });

  it('keeps a retryable unavailable state without inventing totals', () => {
    const onRetry = vi.fn();
    render(
      <StatusBar
        status={null}
        loading={false}
        error={new GalleryApiError(0, 'NETWORK', 'offline')}
        onRetry={onRetry}
      />
    );
    expect(screen.getByText('Backup status unavailable')).toBeInTheDocument();
    screen.getByRole('button', { name: 'Retry' }).click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('DevicesPage', () => {
  it('shows the no-devices empty state', async () => {
    render(<DevicesPage api={makeApi()} />);
    expect(await screen.findByText('No devices paired yet')).toBeInTheDocument();
  });

  it('confirms, revokes and refreshes the list', async () => {
    let revoked = false;
    const revokeDevice = vi.fn(async () => {
      revoked = true;
    });
    const api = makeApi({
      fetchDevices: async () => [makeDevice({ revoked })],
      revokeDevice,
    });
    const user = userEvent.setup();

    render(<DevicesPage api={api} />);
    await screen.findByText('Pixel 8');
    await user.click(screen.getByRole('button', { name: 'Revoke access' }));
    expect(screen.getByText(/Revoke Pixel 8\?/)).toBeInTheDocument();
    expect(revokeDevice).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Yes, revoke' }));
    expect(revokeDevice).toHaveBeenCalledWith('device-1');
    expect(await screen.findByText('Revoked')).toBeInTheDocument();
    expect(
      screen.getByText('Pixel 8 was revoked and can no longer open this library.')
    ).toBeInTheDocument();
  });

  it('shows a re-pair state for authentication failures', async () => {
    const api = makeApi({
      fetchDevices: async () => {
        throw new GalleryApiError(401, 'AUTH_REQUIRED', 'Pair first.');
      },
    });
    render(<DevicesPage api={api} />);
    expect(await screen.findByText('Unlock the gallery on this PC')).toBeInTheDocument();
  });
});

describe('SettingsPage', () => {
  it('blocks invalid values before calling the server', async () => {
    const saveSettings = vi.fn();
    const api = makeApi({ saveSettings });
    const user = userEvent.setup();

    render(<SettingsPage api={api} />);
    const folder = await screen.findByLabelText('Photos folder');
    const port = screen.getByLabelText('Server port');

    await user.clear(folder);
    await user.type(folder, 'Photos');
    await user.clear(port);
    await user.type(port, '80');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(await screen.findByText(/Use a full path/)).toBeInTheDocument();
    expect(screen.getByText(/whole number between 1024 and 65535/)).toBeInTheDocument();
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('saves values and explains when a restart is required', async () => {
    const saveSettings = vi.fn(async () => ({
      ...defaultSettings,
      port: 9000,
      restartRequired: true,
    }));
    const api = makeApi({ saveSettings });
    const user = userEvent.setup();

    render(<SettingsPage api={api} />);
    const port = await screen.findByLabelText('Server port');
    await user.clear(port);
    await user.type(port, '9000');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() =>
      expect(saveSettings).toHaveBeenCalledWith({
        photosFolder: 'C:\\Photos',
        deleteBehavior: 'index_only',
        mirrorFolder: '',
        port: 9000,
      })
    );
    expect(
      await screen.findByText(/Restart the server to use the saved port/)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeEnabled();
  });

  it('opens a one-time pairing QR code from settings', async () => {
    const createPairingCode = vi.fn(async () => defaultPairing);
    const api = makeApi({ createPairingCode });
    const user = userEvent.setup();

    render(<SettingsPage api={api} />);
    await user.click(await screen.findByRole('button', { name: 'Show QR code' }));

    const dialog = await screen.findByRole('dialog', { name: 'Pair a phone' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(await screen.findByLabelText('Pairing QR code')).toBeInTheDocument();
    expect(createPairingCode).toHaveBeenCalledTimes(1);
    expect(screen.getByText('STUDIO-PC')).toBeInTheDocument();
    expect(screen.getByText('https://192.168.1.24:8427')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('allows and blocks phone connections from settings', async () => {
    const setConnection = vi.fn(async (allowed: boolean) => ({
      ...defaultConnection,
      allowed,
    }));
    const api = makeApi({
      fetchConnection: async () => defaultConnection,
      setConnection,
    });
    const user = userEvent.setup();

    render(<SettingsPage api={api} />);
    expect(await screen.findByText('Phone connections are blocked')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Allow phone connections' }));
    await waitFor(() => expect(setConnection).toHaveBeenCalledWith(true));
    expect(await screen.findByText('Phones on this Wi-Fi can connect')).toBeInTheDocument();
    expect(
      screen.getByText('Phones on this Wi-Fi can now reach XueMint.')
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Block phone connections' }));
    await waitFor(() => expect(setConnection).toHaveBeenCalledWith(false));
    expect(await screen.findByText('Phone connections are blocked')).toBeInTheDocument();
  });

  it('surfaces a firewall change that Windows refused', async () => {
    const api = makeApi({
      fetchConnection: async () => ({ ...defaultConnection, allowed: true }),
      setConnection: async () => {
        throw new Error('Windows did not remove the rule.');
      },
    });
    const user = userEvent.setup();

    render(<SettingsPage api={api} />);
    expect(await screen.findByText('Phones on this Wi-Fi can connect')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Block phone connections' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Windows did not remove the rule.'
    );
    expect(
      screen.getByRole('button', { name: 'Block phone connections' })
    ).toBeEnabled();
  });

  it('renders the saved delete behavior and reports server validation errors', async () => {
    const saveSettings = vi.fn(async () => {
      throw new GalleryApiError(400, 'BAD_REQUEST', 'That folder cannot be used.');
    });
    const api = makeApi({ saveSettings });
    const user = userEvent.setup();

    render(<SettingsPage api={api} />);
    const select = await screen.findByLabelText('When a photo is deleted');
    expect(select).toHaveValue('index_only');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(await screen.findByText('That folder cannot be used.')).toBeInTheDocument();
  });
});
