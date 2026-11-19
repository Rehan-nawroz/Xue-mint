import { useCallback, useEffect, useRef, useState } from 'react';
import { mergeTimelinePage } from '@xue-mint/shared';
import type { GalleryAsset } from '@xue-mint/shared';
import type {
  BackupEngine,
  BackupStatus,
  EngineSettings,
  EngineSettingsUpdate,
} from '../engine';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface EngineStatusState {
  status: BackupStatus | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/** Reads status once and then follows every engine-published update. */
export function useEngineStatus(engine: BackupEngine): EngineStatusState {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    engine
      .status()
      .then((next) => {
        setStatus(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        setError(errorMessage(cause));
      })
      .finally(() => setLoading(false));
  }, [engine]);

  useEffect(() => {
    let active = true;
    const apply = (next: BackupStatus) => {
      if (!active) return;
      setStatus(next);
      setError(null);
      setLoading(false);
    };
    const unsubscribe = engine.subscribe(apply);
    engine
      .status()
      .then(apply)
      .catch((cause: unknown) => {
        if (!active) return;
        setError(errorMessage(cause));
        setLoading(false);
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [engine]);

  return { status, loading, error, refresh };
}

export interface EngineSettingsState {
  settings: EngineSettings | null;
  error: string | null;
  saving: boolean;
  save: (update: EngineSettingsUpdate) => Promise<void>;
  refresh: () => void;
}

export function useEngineSettings(engine: BackupEngine): EngineSettingsState {
  const [settings, setSettings] = useState<EngineSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(() => {
    engine
      .getSettings()
      .then((next) => {
        setSettings(next);
        setError(null);
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [engine]);

  useEffect(() => {
    let active = true;
    engine
      .getSettings()
      .then((next) => {
        if (active) setSettings(next);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [engine]);

  const save = useCallback(
    async (update: EngineSettingsUpdate) => {
      setSaving(true);
      setError(null);
      try {
        const next = await engine.setSettings(update);
        setSettings(next);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setSaving(false);
      }
    },
    [engine]
  );

  return { settings, error, saving, save, refresh };
}

export interface TimelineState {
  assets: GalleryAsset[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  moreError: string | null;
  hasMore: boolean;
  loadMore: () => void;
  retry: () => void;
}

/** Loads the PC timeline through the engine, one cursor page at a time. */
export function useTimeline(engine: BackupEngine): TimelineState {
  const [assets, setAssets] = useState<GalleryAsset[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const loadFirst = useCallback(() => {
    let active = true;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    setMoreError(null);
    engine
      .fetchTimeline(null)
      .then((page) => {
        if (!active) return;
        setAssets(page.items);
        setCursor(page.nextCursor);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!active) return;
        inFlight.current = false;
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [engine]);

  useEffect(() => loadFirst(), [loadFirst]);

  const loadMore = useCallback(() => {
    if (inFlight.current || !cursor) return;
    inFlight.current = true;
    setLoadingMore(true);
    setMoreError(null);
    engine
      .fetchTimeline(cursor)
      .then((page) => {
        setAssets((existing) => mergeTimelinePage(existing, page.items));
        setCursor(page.nextCursor);
      })
      .catch((cause: unknown) => setMoreError(errorMessage(cause)))
      .finally(() => {
        inFlight.current = false;
        setLoadingMore(false);
      });
  }, [cursor, engine]);

  return {
    assets,
    loading,
    loadingMore,
    error,
    moreError,
    hasMore: cursor !== null,
    loadMore,
    retry: loadFirst,
  };
}
