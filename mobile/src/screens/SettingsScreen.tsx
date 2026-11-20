import type { ReactNode } from 'react';
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

export function SettingsScreen({
  engine,
  status,
  settings,
  settingsError,
  saving,
  onSettingsChange,
  onPair,
  onRetryStatus,
  diagnostics,
}: SettingsScreenProps) {
  const { choice, setChoice } = useTheme();
  const paired = status?.pairedPc ?? null;
  const connected = status?.connection === 'connected';

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
        </Section>

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
