import { registerPlugin } from '@capacitor/core';
import type { ConnectionState, DiscoveredPc, PairedPc } from './types';

/** Reachability of the stored pairing, as reported by the Kotlin engine. */
export interface NativePairingState {
  paired: boolean;
  pc: PairedPc | null;
  connection: ConnectionState;
  message: string;
}

export interface NativePairOptions {
  addresses: string[];
  port: number;
  fingerprint: string;
  token: string;
  serverName: string;
}

interface NativeEnginePlugin {
  pairPc(options: NativePairOptions): Promise<{ pc: PairedPc }>;
  pairingState(): Promise<NativePairingState>;
  forgetPc(): Promise<void>;
  discoverPc(options: { timeoutMs: number }): Promise<{ services: DiscoveredPc[] }>;
}

const native = registerPlugin<NativeEnginePlugin>('BackupEngine');

/**
 * Thin typed wrapper over the BackupEngine plugin for the operations the app
 * uses. The UI never imports Capacitor; it only sees the engine interface.
 */
export function nativePairPc(options: NativePairOptions): Promise<PairedPc> {
  return native.pairPc(options).then((result) => result.pc);
}

export function nativePairingState(): Promise<NativePairingState> {
  return native.pairingState();
}

export function nativeForgetPc(): Promise<void> {
  return native.forgetPc();
}

export function nativeDiscoverPc(timeoutMs: number): Promise<DiscoveredPc[]> {
  return native.discoverPc({ timeoutMs }).then((result) => result.services);
}
