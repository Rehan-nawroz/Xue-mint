import { isNativePlatform } from './native';

export const SCANNER_ACTIVE_CLASS = 'barcode-scanner-active';
export const CAMERA_DENIED_MESSAGE =
  'Camera access was denied. Enter the code manually instead.';

export class CameraPermissionError extends Error {
  constructor() {
    super(CAMERA_DENIED_MESSAGE);
    this.name = 'CameraPermissionError';
  }
}

export interface PairingScan {
  /** Resolves with the QR text, or rejects when cancelled or the camera fails. */
  result: Promise<string>;
  cancel: () => Promise<void>;
}

function showScanUi() {
  document.body.classList.add(SCANNER_ACTIVE_CLASS);
  document.documentElement.classList.add(SCANNER_ACTIVE_CLASS);
}

function hideScanUi() {
  document.body.classList.remove(SCANNER_ACTIVE_CLASS);
  document.documentElement.classList.remove(SCANNER_ACTIVE_CLASS);
}

/**
 * Opens the on-device camera scanner and resolves with the first QR code seen.
 *
 * Uses the bundled ML Kit model through the Capacitor plugin, so scanning works
 * offline and nothing is sent to a server. The camera preview renders behind the
 * WebView; the web layer only draws the frame and the cancel button.
 */
export async function startPairingScan(): Promise<PairingScan> {
  if (!isNativePlatform()) throw new Error('Camera scanning needs the Android app.');

  const { BarcodeScanner, BarcodeFormat } = await import('@capacitor-mlkit/barcode-scanning');

  const { camera } = await BarcodeScanner.requestPermissions();
  if (camera !== 'granted' && camera !== 'limited') throw new CameraPermissionError();

  showScanUi();

  let settled = false;
  let removeListener: (() => Promise<void>) | null = null;
  let timeout: number | null = null;

  const stop = async () => {
    hideScanUi();
    if (timeout !== null) window.clearTimeout(timeout);
    try {
      await removeListener?.();
    } catch {
      // The listener may already be gone after a scan result.
    }
    try {
      await BarcodeScanner.removeAllListeners();
      await BarcodeScanner.stopScan();
    } catch {
      // Stopping an already-stopped scan is harmless.
    }
  };

  const result = new Promise<string>((resolve, reject) => {
    const finish = async (value: string | null, error?: Error) => {
      if (settled) return;
      settled = true;
      await stop();
      if (value) resolve(value);
      else reject(error ?? new Error('No QR code was found.'));
    };

    void BarcodeScanner.addListener('barcodesScanned', ({ barcodes }) => {
      const barcode = barcodes[0];
      const value = barcode?.rawValue ?? barcode?.displayValue ?? null;
      void finish(value, value ? undefined : new Error('That code could not be read.'));
    }).then((listener) => {
      removeListener = () => listener.remove();
    });

    void BarcodeScanner.addListener('scanError', ({ message }) => {
      void finish(null, new Error(message || 'The camera could not scan the code.'));
    });

    timeout = window.setTimeout(() => {
      void finish(null, new Error('The scan took too long. Try again.'));
    }, 120_000);

    BarcodeScanner.startScan({ formats: [BarcodeFormat.QrCode] }).catch((cause: unknown) => {
      void finish(null, cause instanceof Error ? cause : new Error(String(cause)));
    });
  });

  return {
    result,
    cancel: async () => {
      if (settled) return;
      settled = true;
      await stop();
    },
  };
}
