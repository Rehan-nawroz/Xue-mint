import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import QRCode from 'qrcode';
import logoUrl from '../../assets/brand/logo.png';
import '@xue-mint/shared/theme.css';
import './style.css';

interface PairingCode {
  version: number;
  serverName: string;
  addresses: string[];
  port: number;
  fingerprint: string;
  token: string | null;
  expiresAt: string | null;
}

interface SetupStatus {
  serverReady: boolean;
  serverError: string | null;
  port: number;
  photosDir: string;
  dataDir: string;
  autostart: boolean;
  firewallRule: boolean;
  version: string;
}

interface FirewallResult {
  ok: boolean;
  message: string;
}

const isTauri = '__TAURI_INTERNALS__' in window;
const view = isTauri
  ? getCurrentWindow().label
  : (new URLSearchParams(window.location.search).get('view') ?? 'pairing');

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app');

async function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri) return invoke<T>(name, args);
  return demo(name) as T;
}

function demo(name: string): unknown {
  const pairing: PairingCode = {
    version: 1,
    serverName: 'STUDIO-PC',
    addresses: ['192.168.1.24'],
    port: 8427,
    fingerprint:
      '4B:1E:9C:2A:77:0D:31:8F:6E:52:A0:CD:19:44:B8:7E:' +
      '23:91:0F:5A:C7:64:D2:88:3B:EE:15:6D:9A:40:52:FC',
    token: 'XM7K-4QDP',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
  switch (name) {
    case 'create_pairing_code':
      return { ...pairing, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
    case 'setup_status':
      return {
        serverReady: true,
        serverError: null,
        port: 8427,
        photosDir: 'C:\\Users\\You\\Pictures\\XueMint',
        dataDir: 'C:\\Users\\You\\AppData\\Local\\XueMint',
        autostart: true,
        firewallRule: false,
        version: '0.1.0 (demo)',
      } satisfies SetupStatus;
    case 'set_autostart':
      return null;
    case 'add_firewall_rule':
      return {
        ok: true,
        message: 'Windows now allows XueMint on private networks.',
      } satisfies FirewallResult;
    case 'open_gallery':
    case 'open_pairing':
    case 'quit':
      return null;
    default:
      throw new Error(`Unknown command in demo mode: ${name}`);
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char
  );
}

function masthead(eyebrow: string, title: string, subtitle: string): string {
  return `
    <header class="masthead">
      <div class="brand">
        <img src="${logoUrl}" alt="" width="36" height="36" />
        <div>
          <span class="eyebrow">${escapeHtml(eyebrow)}</span>
          <strong>${escapeHtml(title)}</strong>
        </div>
      </div>
      <p class="masthead__note">${escapeHtml(subtitle)}</p>
    </header>
  `;
}

function renderError(container: HTMLElement, message: string, retry: () => void): void {
  container.querySelector('[data-alert]')?.remove();
  const panel = document.createElement('div');
  panel.dataset.alert = 'true';
  panel.className = 'alert';
  panel.setAttribute('role', 'alert');
  const title = document.createElement('strong');
  title.textContent = 'Something needs attention';
  const text = document.createElement('p');
  text.textContent = message;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn--ghost';
  button.textContent = 'Try again';
  button.addEventListener('click', retry);
  panel.append(title, text, button);
  container.append(panel);
}

function renderPairing(): void {
  app!.innerHTML = `
    ${masthead('Private photo backup', 'Pair your phone', 'Same Wi-Fi. No account. No cloud.')}
    <div class="pair-grid">
      <section class="qr-card" aria-label="Pairing QR code">
        <div class="qr-card__frame">
          <canvas id="pairing-qr" width="260" height="260"></canvas>
        </div>
        <p class="qr-card__caption">Scan with the XueMint app</p>
        <p class="countdown" id="pairing-countdown" role="status">Preparing a fresh code…</p>
      </section>
      <section class="pair-copy">
        <ol class="steps">
          <li>Connect your phone to the same Wi-Fi as this PC.</li>
          <li>Open XueMint and scan the code.</li>
          <li>The code works once and expires in 10 minutes.</li>
        </ol>
        <dl class="details">
          <div>
            <dt>This PC</dt>
            <dd id="pairing-name">—</dd>
          </div>
          <div>
            <dt>Address</dt>
            <dd class="addresses" id="pairing-addresses">—</dd>
          </div>
        </dl>
        <details class="fingerprint">
          <summary>Certificate fingerprint</summary>
          <code id="pairing-fingerprint">—</code>
          <p>Your phone remembers this value so it only trusts this PC.</p>
        </details>
        <div class="actions">
          <button type="button" class="btn" id="new-code">New code</button>
          <button type="button" class="btn btn--ghost" id="pair-gallery">Open gallery</button>
        </div>
        <p class="fineprint">The code is single use. Generate a new one from the tray whenever you need it.</p>
      </section>
    </div>
  `;

  const qr = app!.querySelector<HTMLCanvasElement>('#pairing-qr')!;
  const countdown = app!.querySelector<HTMLParagraphElement>('#pairing-countdown')!;
  const name = app!.querySelector<HTMLElement>('#pairing-name')!;
  const addresses = app!.querySelector<HTMLElement>('#pairing-addresses')!;
  const fingerprint = app!.querySelector<HTMLElement>('#pairing-fingerprint')!;
  const newCode = app!.querySelector<HTMLButtonElement>('#new-code')!;
  let timer: number | undefined;

  const load = async (): Promise<void> => {
    if (timer) window.clearInterval(timer);
    newCode.disabled = true;
    countdown.textContent = 'Preparing a fresh code…';
    try {
      const code = await command<PairingCode>('create_pairing_code');
      await QRCode.toCanvas(qr, JSON.stringify(code), {
        width: 260,
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#000000', light: '#FFFFFF' },
      });

      name.textContent = code.serverName;
      addresses.replaceChildren();
      for (const address of code.addresses) {
        const line = document.createElement('span');
        line.className = 'address';
        line.textContent = `https://${address}:${code.port}`;
        addresses.append(line);
      }
      fingerprint.textContent = code.fingerprint;

      if (!code.token) {
        countdown.textContent = 'This build did not return a token. Generate a new code.';
        countdown.classList.add('countdown--expired');
        return;
      }

      const expires = code.expiresAt ? Date.parse(code.expiresAt) : Number.NaN;
      const tick = (): void => {
        if (!Number.isFinite(expires)) {
          countdown.textContent = 'Single-use code';
          return;
        }
        const remaining = expires - Date.now();
        if (remaining <= 0) {
          countdown.textContent = 'Code expired — generate a new one';
          countdown.classList.add('countdown--expired');
          window.clearInterval(timer);
          return;
        }
        const minutes = Math.floor(remaining / 60_000);
        const seconds = Math.floor((remaining % 60_000) / 1000);
        countdown.textContent = `Expires in ${minutes}:${String(seconds).padStart(2, '0')}`;
        countdown.classList.remove('countdown--expired');
      };
      tick();
      timer = window.setInterval(tick, 1000);
    } catch (error) {
      countdown.textContent = 'Could not create a pairing code';
      countdown.classList.add('countdown--expired');
      renderError(
        app!.querySelector<HTMLElement>('.pair-copy')!,
        error instanceof Error ? error.message : String(error),
        () => void load()
      );
    } finally {
      newCode.disabled = false;
    }
  };

  newCode.addEventListener('click', () => void load());
  if (isTauri) {
    void listen('refresh-pairing', () => void load());
  }
  app!.querySelector('#pair-gallery')!.addEventListener('click', () => {
    void command('open_gallery').catch(() => undefined);
  });
  void load();
}

function renderSetup(): void {
  app!.classList.add('app--setup');
  app!.innerHTML = `
    ${masthead('Desktop setup', 'Your photos stay here', 'This PC is the cloud. Your phone backs up over your own Wi-Fi.')}
    <div class="setup-body">
      <section class="panel" aria-labelledby="server-heading">
        <div>
          <h2 id="server-heading">Backup server</h2>
          <p id="server-copy" class="panel__copy">Checking the local server…</p>
        </div>
        <span class="pill" id="server-pill">Starting</span>
      </section>

      <section class="panel" aria-labelledby="firewall-heading">
        <div>
          <h2 id="firewall-heading">Let your phone connect</h2>
          <p class="panel__copy" id="firewall-copy">
            Windows Firewall must allow XueMint on private networks. This never opens the
            server to the internet.
          </p>
        </div>
        <button type="button" class="btn" id="firewall-button" disabled>Checking…</button>
      </section>

      <section class="panel" aria-labelledby="autostart-heading">
        <div>
          <h2 id="autostart-heading">Start with Windows</h2>
          <p class="panel__copy">
            Keeps backups working after a restart. Turn this off if you prefer to start
            XueMint yourself.
          </p>
        </div>
        <button
          type="button"
          class="switch"
          id="autostart-toggle"
          role="switch"
          aria-checked="false"
          aria-label="Start XueMint with Windows"
          disabled
        >
          <span class="switch__track"><span class="switch__thumb"></span></span>
        </button>
      </section>

      <section class="panel panel--quiet" aria-labelledby="library-heading">
        <div>
          <h2 id="library-heading">Photo library</h2>
          <p class="panel__copy mono" id="library-path">—</p>
        </div>
        <button type="button" class="btn btn--ghost" id="open-settings">Manage in gallery</button>
      </section>

      <p class="status-line" id="setup-message" role="status"></p>

      <footer class="setup-footer">
        <div class="actions">
          <button type="button" class="btn" id="setup-gallery">Open gallery</button>
          <button type="button" class="btn btn--ghost" id="setup-pair">Pair a phone</button>
        </div>
        <div class="footer-meta">
          <span id="setup-version">XueMint</span>
          <button type="button" class="link-button" id="quit">Quit XueMint</button>
        </div>
      </footer>
    </div>
  `;

  const serverCopy = app!.querySelector<HTMLElement>('#server-copy')!;
  const serverPill = app!.querySelector<HTMLElement>('#server-pill')!;
  const firewallCopy = app!.querySelector<HTMLElement>('#firewall-copy')!;
  const firewallButton = app!.querySelector<HTMLButtonElement>('#firewall-button')!;
  const autostart = app!.querySelector<HTMLButtonElement>('#autostart-toggle')!;
  const library = app!.querySelector<HTMLElement>('#library-path')!;
  const message = app!.querySelector<HTMLElement>('#setup-message')!;
  const version = app!.querySelector<HTMLElement>('#setup-version')!;

  let status: SetupStatus | null = null;

  const paint = (next: SetupStatus): void => {
    status = next;
    serverPill.textContent = next.serverReady ? 'Running' : 'Stopped';
    serverPill.classList.toggle('pill--ok', next.serverReady);
    serverPill.classList.toggle('pill--bad', !next.serverReady);
    serverCopy.textContent = next.serverReady
      ? `Listening on port ${next.port} for this PC and paired phones.`
      : (next.serverError ?? 'The local server is not running.');

    firewallButton.disabled = next.firewallRule;
    firewallButton.textContent = next.firewallRule ? 'Allowed' : 'Allow connections';
    firewallCopy.textContent = next.firewallRule
      ? 'Windows allows XueMint on private networks. Paired phones on this Wi-Fi can reach it.'
      : 'Windows Firewall must allow XueMint on private networks. Windows will ask for permission once; this never opens the server to the internet.';

    autostart.disabled = false;
    autostart.setAttribute('aria-checked', String(next.autostart));

    library.textContent = next.photosDir;
    version.textContent = `XueMint ${next.version}`;
  };

  const refresh = async (): Promise<void> => {
    try {
      paint(await command<SetupStatus>('setup_status'));
    } catch (error) {
      message.textContent = error instanceof Error ? error.message : String(error);
    }
  };

  firewallButton.addEventListener('click', async () => {
    firewallButton.disabled = true;
    firewallButton.textContent = 'Allowing…';
    message.textContent = '';
    try {
      const result = await command<FirewallResult>('add_firewall_rule');
      message.textContent = result.message;
      if (result.ok) message.classList.add('status-line--ok');
      await refresh();
    } catch (error) {
      message.textContent =
        error instanceof Error ? error.message : 'Windows did not allow the rule.';
      message.classList.remove('status-line--ok');
      firewallButton.disabled = false;
      firewallButton.textContent = 'Try again';
    }
  });

  autostart.addEventListener('click', async () => {
    if (!status) return;
    const enabled = !status.autostart;
    autostart.disabled = true;
    try {
      await command('set_autostart', { enabled });
      paint({ ...status, autostart: enabled });
      message.textContent = enabled
        ? 'XueMint will start with Windows.'
        : 'XueMint will no longer start with Windows.';
    } catch (error) {
      message.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      autostart.disabled = false;
    }
  });

  app!.querySelector('#open-settings')!.addEventListener('click', () => {
    void command('open_gallery').catch(() => undefined);
  });
  app!.querySelector('#setup-gallery')!.addEventListener('click', () => {
    void command('open_gallery').catch(() => undefined);
  });
  app!.querySelector('#setup-pair')!.addEventListener('click', () => {
    void command('open_pairing').catch(() => undefined);
  });
  app!.querySelector('#quit')!.addEventListener('click', () => {
    void command('quit').catch(() => undefined);
  });

  void refresh();
}

if (view === 'setup') {
  renderSetup();
} else if (view === 'pairing') {
  renderPairing();
} else {
  app.textContent = `Unknown desktop window: ${view}`;
}
