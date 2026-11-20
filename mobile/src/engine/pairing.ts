import type { PairingPayload } from './types';

/** Plain-language failures shown in the pairing dialog. */
export const PAIRING_MESSAGES = {
  notACode: 'This is not a pairing code.',
  wrongVersion:
    'This code was made by a different app version. Update the app or the desktop.',
  damaged: 'The code is damaged. Generate a new one on the PC.',
  expired: 'This code expired. Generate a new one on the PC.',
  unreachable:
    'Could not reach the PC. Check that both devices are on the same Wi-Fi and try again.',
} as const;

/** Uppercase, colon-separated SHA-256 fingerprint used for display and pinning. */
export function formatFingerprint(value: string): string {
  const hex = value.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  return hex
    .match(/.{1,2}/g)
    ?.join(':')
    .toUpperCase() ?? '';
}

/** Lower-case, colon-free form compared against the certificate digest. */
export function normalizeFingerprint(value: string): string {
  return value.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Turns the raw QR text into a validated payload.
 *
 * The desktop encodes its pairing JSON directly (not a URL), so only JSON is
 * accepted. Failures always carry a sentence a person can act on.
 */
export function parsePairingPayload(raw: string): PairingPayload {
  const text = raw.replace(/^\uFEFF/, '').trim();
  if (!text) throw new Error(PAIRING_MESSAGES.notACode);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(PAIRING_MESSAGES.notACode);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(PAIRING_MESSAGES.notACode);
  }

  const value = parsed as Partial<PairingPayload>;
  if (!isNonEmptyString(value.token)) throw new Error(PAIRING_MESSAGES.notACode);
  if (value.version !== 1) throw new Error(PAIRING_MESSAGES.wrongVersion);
  if (!isNonEmptyString(value.serverName)) throw new Error(PAIRING_MESSAGES.notACode);

  const port = value.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(PAIRING_MESSAGES.damaged);
  }

  const addresses = value.addresses;
  if (
    !Array.isArray(addresses) ||
    addresses.length === 0 ||
    !addresses.every((address) => isNonEmptyString(address))
  ) {
    throw new Error(PAIRING_MESSAGES.damaged);
  }

  if (!isNonEmptyString(value.fingerprint) || normalizeFingerprint(value.fingerprint).length !== 64) {
    throw new Error(PAIRING_MESSAGES.damaged);
  }

  let expiresAt: string | null = null;
  if (value.expiresAt !== null && value.expiresAt !== undefined) {
    const expires = new Date(value.expiresAt);
    if (Number.isNaN(expires.getTime())) throw new Error(PAIRING_MESSAGES.damaged);
    if (expires.getTime() <= Date.now()) throw new Error(PAIRING_MESSAGES.expired);
    expiresAt = expires.toISOString();
  }

  return {
    version: 1,
    serverName: value.serverName.trim(),
    addresses: addresses.map((address) => address.trim()),
    port,
    fingerprint: formatFingerprint(value.fingerprint),
    token: value.token,
    expiresAt,
  };
}
