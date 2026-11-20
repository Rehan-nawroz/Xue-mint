import type { ReactNode } from 'react';
import React from 'react';
import { formatDateTime, useTheme } from '@xue-mint/shared';
import type { ThemeChoice } from '@xue-mint/shared';
import logoUrl from '../../../assets/brand/mock-logo.svg';
import type {
  BackupStatus,
  BackupEngine,
  EngineSettings,
  EngineSettingsUpdate,
  NativeDiagnostics,
} from '../engine';
import { ChevronRightIcon, CloudIcon, CloudOffIcon, PairIcon } from '../components/icons';
import { EnginePanel } from '../components/EnginePanel';
import { NativeSpikePanel } from '../components/NativeSpikePanel';

interface SettingsScreenProps {
  engine: BackupEngine;
  status: BackupStatus | null;
  settings: EngineSettings | null;
  settingsError: string | null;
  saving: boolean;
  onSettingsChange: (update: EngineSettingsUpdate) => Promise<void>;
  onPair: () => void;
  onRetryStatus: () => void;
  onBackupNow: () => Promise<void>;
  diagnostics: NativeDiagnostics | null;
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h2 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
        {title}
      </h2>
      {description ? (
        <p className="mt-1 px-1 text-[11px] leading-relaxed text-muted">{description}</p>
      ) : null}
      <div className="mt-2 overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
        {children}
      </div>
    </section>
  );
}

function SwitchRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold leading-tight">{label}</p>
        <p className="mt-0.5 text-[11px] leading-snug text-muted">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className="switch"
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="switch__thumb" />
      </button>
    </div>
  );
}

function connectionLabel(status: BackupStatus | null): string {
  if (!status) return 'Checking…';
  if (status.connection === 'connected') return 'Connected';
  if (status.connection === 'unreachable') return 'Not reachable';
  if (status.connection === 'blocked') return 'Wi-Fi blocked';
  if (status.connection === 'not_paired') return 'Not paired';
  return 'Needs attention';
}

/**
 * Per-maker steps that keep the app running in the background. Aggressive
 * OEM battery savers are the top reason background backup silently stops.
 */
const BATTERY_GUIDANCE: Record<string, { label: string; steps: string[] }> = {
  samsung: {
    label: 'Samsung',
    steps: [
      'Open Settings → Battery → Background usage limits.',
      'Tap "Never sleeping apps" and add Xue-Mint.',
      'In "Sleeping apps", remove Xue-Mint if it is listed.',
      'Settings → Battery → More battery settings: turn off "Adaptive battery" if backup still pauses.',
    ],
  },
  xiaomi: {
    label: 'Xiaomi / Redmi / POCO',
    steps: [
      'Open Settings → Apps → Manage apps → Xue-Mint → Autostart: on.',
      'In the same screen open "Battery saver" and pick "No restrictions".',
      'Settings → Battery → turn off battery optimization for Xue-Mint.',
    ],
  },
  oppo: {
    label: 'OPPO / Realme / OnePlus',
    steps: [
      'Open Settings → Battery → More settings → Optimize battery use → Xue-Mint: "Don\'t optimize".',
      'Settings → Apps → Xue-Mint → Battery usage → "Allow background activity".',
      'In the recent-apps view, lock Xue-Mint so the system does not close it.',
    ],
  },
  huawei: {
    label: 'Huawei / Honor',
    steps: [
      'Open Settings → Battery → App launch → Xue-Mint: turn off "Manage automatically".',
      'Allow Auto-launch, Secondary launch and Run in background.',
      'Settings → Battery → More battery settings → close "Sleeping mode" if backup still pauses.',
    ],
  },
  stock: {
    label: 'Pixel and other Android',
    steps: [
      'Open Settings → Apps → Xue-Mint → Battery → choose "Unrestricted".',
      'Leave "Adaptive Battery" on; Android rarely stops unrestricted apps.',
    ],
  },
};

function DeviceHealthSection({ engine }: { engine: BackupEngine }) {
  const [health, setHealth] = React.useState<Awaited<
    ReturnType<NonNullable<BackupEngine['deviceStatus']>>
  > | null>(null);

  const refresh = React.useCallback(async () => {
    if (!engine.deviceStatus) return;
    try {
      setHealth(await engine.deviceStatus());
    } catch {
      // The section stays hidden; the switches above still work.
    }
  }, [engine]);

  React.useEffect(() => {
    void refresh();
    // The exemption and permission asks are answered in system dialogs, so
    // re-check when the user comes back to the app.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  if (!health) return null;

  const brandKey = Object.keys(BATTERY_GUIDANCE).includes(health.manufacturer)
    ? health.manufacturer
    : 'stock';
  const brandOrder = [brandKey, ...Object.keys(BATTERY_GUIDANCE).filter((k) => k !== brandKey)];

  const allowNotifications = async () => {
    await engine.requestNotificationPermission?.();
    await refresh();
  };

  return (
    <Section
      title="Keep backup running"
      description="Some phones stop background apps to save battery. These steps keep photo backup alive."
    >
      <div className="p-3">
        <div
          data-testid="battery-state"
          className={`rounded-xl px-3 py-2.5 text-[12px] leading-snug ${
            health.batteryOptimized
              ? 'bg-warning-soft text-ink'
              : 'bg-success-soft text-ink'
          }`}
        >
          {health.batteryOptimized
            ? 'Battery optimization may pause backup in the background.'
            : 'Backup is allowed to run in the background.'}
        </div>

        {health.batteryOptimized ? (
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              data-testid="battery-exempt"
              className="flex-1 rounded-xl border border-line px-3 py-2 text-[12px] font-semibold hover:bg-surface-2"
              onClick={() => {
                void engine.requestBatteryExemption?.().then(() => refresh());
              }}
            >
              Ask Android to exempt
            </button>
            <button
              type="button"
              data-testid="battery-open-settings"
              className="flex-1 rounded-xl border border-line px-3 py-2 text-[12px] font-semibold text-muted hover:bg-surface-2"
              onClick={() => {
                void engine.openBatterySettings?.();
              }}
            >
              Open battery settings
            </button>
          </div>
        ) : null}

        {!health.notificationsAllowed ? (
          <div className="mt-2 flex items-center gap-3 rounded-xl border border-line px-3 py-2.5">
            <p className="min-w-0 flex-1 text-[12px] leading-snug text-muted">
              Allow notifications to see backup progress from the lock screen.
            </p>
            <button
              type="button"
              data-testid="allow-notifications"
              className="rounded-xl bg-brand px-3 py-2 text-[12px] font-semibold text-white"
              onClick={() => {
                void allowNotifications();
              }}
            >
              Allow
            </button>
          </div>
        ) : null}

        <div className="mt-3" data-testid="battery-guidance">
          {brandOrder.map((key, index) => {
            const guide = BATTERY_GUIDANCE[key];
            const active = index === 0;
            return active ? (
              <div key={key} className="mb-2">
                <p className="text-[12px] font-semibold">{guide.label}</p>
                <ol className="mt-1 list-decimal space-y-1 pl-5 text-[12px] leading-snug text-muted">
                  {guide.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </div>
            ) : (
              <details key={key} className="mt-1">
                <summary className="cursor-pointer text-[12px] font-semibold text-muted">
                  {guide.label}
                </summary>
                <ol className="mt-1 list-decimal space-y-1 pl-5 text-[12px] leading-snug text-muted">
                  {guide.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </details>
            );
          })}
        </div>
      </div>
    </Section>
  );
}

export function SettingsScreen({
  engine,
  status,
  settings,
  settingsError,
  saving,
  onSettingsChange,
  onPair,
  onRetryStatus,
  onBackupNow,
  diagnostics,
}: SettingsScreenProps) {
  const { choice, setChoice } = useTheme();
  const paired = status?.pairedPc ?? null;
  const connected = status?.connection === 'connected';
  const backupRunning = status?.phase !== undefined && status.phase !== 'idle';

  const themeOptions: Array<{ id: ThemeChoice; label: string }> = [
    { id: 'system', label: 'System' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
  ];

  return (
    <div className="screen-scroll min-h-0 flex-1 overflow-y-auto bg-app">
      <div className="safe-top px-4 pb-2 pt-3">
        <h1 className="text-[23px] font-bold tracking-tight">Settings</h1>
        <p className="text-[11px] text-muted">Backup rules, your PC and this app</p>
      </div>

      <div className="space-y-5 px-4 pb-8">
        {settingsError ? (
          <p className="rounded-xl bg-danger-soft px-3 py-2 text-[12px] text-danger" role="alert">
            {settingsError}
          </p>
        ) : null}

        <Section title="Backup" description="Your photos go straight to your own PC.">
          <SwitchRow
            label="Automatic backup"
            description="Watch for new photos and back them up in the background."
            checked={settings?.autoBackup ?? true}
            disabled={!settings || saving}
            onChange={(next) => void onSettingsChange({ autoBackup: next })}
          />
          <SwitchRow
            label="Wi-Fi only"
            description="Only back up on your home network, never on mobile data."
            checked={settings?.wifiOnly ?? true}
            disabled={!settings || saving}
            onChange={(next) => void onSettingsChange({ wifiOnly: next })}
          />
          <SwitchRow
            label="Only while charging"
            description="Wait until the phone is plugged in before sending photos."
            checked={settings?.chargingOnly ?? false}
            disabled={!settings || saving}
            onChange={(next) => void onSettingsChange({ chargingOnly: next })}
          />
          <div className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold leading-tight">Run a backup now</p>
              <p className="mt-0.5 text-[11px] leading-snug text-muted">
                Send everything your PC is missing, right away.
              </p>
            </div>
            <button
              type="button"
              data-testid="settings-backup-now"
              className="flex-none rounded-full bg-brand px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
              disabled={backupRunning}
              onClick={onBackupNow}
            >
              {backupRunning ? 'Backing up…' : 'Back up now'}
            </button>
          </div>
        </Section>

        <DeviceHealthSection engine={engine} />

        <Section title="Your PC">
          <div className="px-4 py-3">
            <div className="flex items-start gap-3">
              <span
                className={`flex h-9 w-9 flex-none items-center justify-center rounded-full ${
                  connected ? 'bg-success-soft text-success' : 'bg-warning-soft text-muted'
                }`}
              >
                {connected ? (
                  <CloudIcon className="h-[18px] w-[18px]" />
                ) : (
                  <CloudOffIcon className="h-[18px] w-[18px]" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold leading-tight">
                  {paired?.name ?? 'No PC connected'}
                </p>
                <p className="mt-0.5 text-[11px] text-muted">
                  {paired
                    ? `${paired.addresses[0] ?? 'Address pending'}:${paired.port}`
                    : 'Pair once to start backup'}
                </p>
                {paired ? (
                  <p className="mt-1 text-[10px] text-muted">
                    Last backup{' '}
                    {status?.lastBackupAt
                      ? formatDateTime(new Date(status.lastBackupAt))
                      : 'has not run yet'}
                  </p>
                ) : null}
              </div>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                  connected
                    ? 'bg-success-soft text-success'
                    : status?.connection === 'error' || status?.connection === 'blocked'
                      ? 'bg-danger-soft text-danger'
                      : 'bg-warning-soft text-ink'
                }`}
              >
                {connectionLabel(status)}
              </span>
            </div>

            {paired ? (
              <details className="mt-3 rounded-xl bg-surface-2 px-3 py-2">
                <summary className="cursor-pointer text-[10px] font-semibold text-brand">
                  Certificate fingerprint
                </summary>
                <code className="mt-1 block break-all font-mono text-[9.5px] leading-relaxed text-muted">
                  {paired.fingerprint}
                </code>
              </details>
            ) : null}

            <button
              type="button"
              className="mt-3 flex w-full items-center justify-between rounded-xl border border-line px-3 py-2.5 text-[12px] font-semibold hover:bg-surface-2"
              onClick={onPair}
            >
              <span className="flex items-center gap-2">
                <PairIcon className="h-4 w-4 text-brand" />
                {paired ? 'Pair a different PC' : 'Pair with your PC'}
              </span>
              <ChevronRightIcon className="h-4 w-4 text-muted" />
            </button>
            {paired && !connected && status?.message ? (
              <p className="mt-2 rounded-xl bg-warning-soft px-3 py-2 text-[10px] leading-relaxed text-ink">
                {status.message}
              </p>
            ) : null}

            {paired && !connected ? (
              <button
                type="button"
                className="mt-2 rounded-full border border-line px-3 py-1.5 text-[11px] font-semibold text-ink hover:bg-surface-2"
                onClick={onRetryStatus}
              >
                Retry connection
              </button>
            ) : null}

            <p className="mt-2 text-[10px] leading-relaxed text-muted">
              {engine.mode === 'native'
                ? 'Pair by scanning the code shown on your PC, or enter it manually if the camera is unavailable.'
                : 'Pairing here uses the sample PC; the installed app scans the code straight from your PC screen.'}
            </p>
          </div>
        </Section>

        <Section title="Appearance">
          <div className="p-3">
            <div
              className="grid grid-cols-3 gap-1 rounded-xl bg-surface-2 p-1"
              role="radiogroup"
              aria-label="Appearance"
            >
              {themeOptions.map((option) => {
                const selected = choice === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={`rounded-lg px-2 py-2 text-[11px] font-semibold transition-colors ${
                      selected ? 'bg-surface text-ink shadow-sm' : 'text-muted'
                    }`}
                    onClick={() => setChoice(option.id)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
        </Section>

        {diagnostics ? (
          <Section
            title="Developer tools"
            description="Only shown on Android. Run these with the desktop app open on the same Wi-Fi."
          >            <div className="p-3">
              <EnginePanel engine={engine} />
            </div>
          </Section>
        ) : null}

        {diagnostics ? (
          <Section
            title="Native spike checks"
            description="The four riskiest integration checks, kept from the first native build."
          >
            <div className="p-3">
              <NativeSpikePanel diagnostics={diagnostics} />
            </div>
          </Section>
        ) : null}

        <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-4">
          <img
            className="h-11 w-11 rounded-xl"
            src={logoUrl}
            alt="Xue-Mint mock logo"
            width={44}
            height={44}
          />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold">Xue-Mint</p>
            <p className="text-[11px] text-muted">
              Version 0.1.0 · {engine.mode === 'mock' ? 'Browser preview' : 'Android'}
            </p>
            <p className="mt-1 text-[10px] leading-relaxed text-muted">
              Your photos stay on your phone and your PC. No accounts, no cloud.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
