import { createMockEngine } from './mock';
import type { MockScenario } from './mock';
import { createNativeDiagnostics } from './native-diagnostics';
import { createNativeEngine, isNativePlatform } from './native';
import type { BackupEngine, NativeDiagnostics } from './types';

export * from './types';
export { DEMO_PAIRING_PAYLOAD, buildMockLibrary } from './mock';
export type { MockEngineOptions, MockScenario } from './mock';
export { isNativePlatform } from './native';

interface EngineFactoryOptions {
  /** Overrides the URL query string in tests. */
  search?: string;
}

/**
 * Picks the implementation for this host: native on an Android WebView, the
 * browser mock everywhere else. Query parameters make UI states reachable in a
 * normal browser without a device: `?scenario=offline`, `empty` or `unpaired`.
 */
export function createEngine(options: EngineFactoryOptions = {}): BackupEngine {
  const search = options.search ?? (typeof window === 'undefined' ? '' : window.location.search);
  const params = new URLSearchParams(search);
  if (isNativePlatform() && !params.has('mock')) {
    return createNativeEngine();
  }

  const scenarioParam = params.get('scenario');
  const scenario: MockScenario =
    scenarioParam === 'offline' || scenarioParam === 'unpaired' || scenarioParam === 'empty'
      ? scenarioParam
      : 'ready';
  const count = Number.parseInt(params.get('count') ?? '', 10);
  const latency = Number.parseInt(params.get('latency') ?? '', 10);
  const failUploads = params.get('failUploads') === '1';

  return createMockEngine({
    scenario,
    count: Number.isFinite(count) && count > 0 ? count : undefined,
    latencyMs: Number.isFinite(latency) ? latency : undefined,
    failUploads,
  });
}

/** Native spike checks, or null in a normal browser. */
export function createDiagnostics(): NativeDiagnostics | null {
  if (!isNativePlatform()) return null;
  return createNativeDiagnostics();
}
