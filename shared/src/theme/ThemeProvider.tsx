import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'xue-mint-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function readStoredTheme(storage: Pick<Storage, 'getItem'> | undefined): ThemeChoice {
  try {
    const stored = storage?.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): ResolvedTheme {
  if (choice === 'light' || choice === 'dark') return choice;
  return prefersDark ? 'dark' : 'light';
}

interface ThemeContextValue {
  choice: ThemeChoice;
  resolved: ResolvedTheme;
  setChoice: (choice: ThemeChoice) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

interface ThemeProviderProps {
  children: ReactNode;
  /** Injectable storage for tests; defaults to window.localStorage. */
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
}

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function prefersDarkNow(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(DARK_QUERY).matches
      : false;
  } catch {
    return false;
  }
}

/**
 * Applies the choice to the document: system mode removes the override so the
 * OS preference keeps tracking live, explicit modes pin a value.
 */
export function applyTheme(choice: ThemeChoice): ResolvedTheme {
  const resolved = resolveTheme(choice, prefersDarkNow());
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    if (choice === 'system') {
      delete root.dataset.theme;
    } else {
      root.dataset.theme = choice;
    }
    root.style.colorScheme = choice === 'system' ? '' : resolved;
  }
  return resolved;
}

export function ThemeProvider({ children, storage }: ThemeProviderProps) {
  const store = useMemo(() => storage ?? defaultStorage(), [storage]);
  const [choice, setChoiceState] = useState<ThemeChoice>(() => readStoredTheme(store));
  const [prefersDark, setPrefersDark] = useState(prefersDarkNow);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    setPrefersDark(query.matches);
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    }
    // Older Safari only exposes the deprecated listener API.
    query.addListener?.(onChange);
    return () => query.removeListener?.(onChange);
  }, []);

  const resolved = resolveTheme(choice, prefersDark);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (choice === 'system') {
      delete root.dataset.theme;
    } else {
      root.dataset.theme = choice;
    }
    root.style.colorScheme = choice === 'system' ? '' : resolved;
  }, [choice, resolved]);

  const setChoice = useCallback(
    (next: ThemeChoice) => {
      setChoiceState(next);
      try {
        store?.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // Storage can be unavailable (private mode); the choice still applies now.
      }
    },
    [store]
  );

  const value = useMemo(
    () => ({ choice, resolved, setChoice }),
    [choice, resolved, setChoice]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside a ThemeProvider');
  return value;
}
