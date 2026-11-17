import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  THEME_STORAGE_KEY,
  ThemeProvider,
  isThemeChoice,
  readStoredTheme,
  resolveTheme,
  useTheme,
} from '@xue-mint/shared';

function Probe() {
  const { choice, resolved, setChoice } = useTheme();
  return (
    <div>
      <span data-testid="choice">{choice}</span>
      <span data-testid="resolved">{resolved}</span>
      <button type="button" onClick={() => setChoice('dark')}>
        pick dark
      </button>
      <button type="button" onClick={() => setChoice('light')}>
        pick light
      </button>
      <button type="button" onClick={() => setChoice('system')}>
        pick system
      </button>
    </div>
  );
}

function fakeStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: (key: string) => (key === THEME_STORAGE_KEY ? value : null),
    setItem: (key: string, next: string) => {
      if (key === THEME_STORAGE_KEY) value = next;
    },
    read: () => value,
  };
}

describe('theme helpers', () => {
  it('resolves explicit and system choices', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('reads only valid stored values', () => {
    expect(isThemeChoice('dark')).toBe(true);
    expect(isThemeChoice('purple')).toBe(false);
    expect(readStoredTheme(fakeStorage('light'))).toBe('light');
    expect(readStoredTheme(fakeStorage('nonsense'))).toBe('system');
    expect(readStoredTheme(undefined)).toBe('system');
  });
});

describe('ThemeProvider', () => {
  beforeEach(() => {
    delete document.documentElement.dataset.theme;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string): MediaQueryList => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
  });

  it('persists an explicit choice and applies it to the document', () => {
    const storage = fakeStorage();
    render(
      <ThemeProvider storage={storage}>
        <Probe />
      </ThemeProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'pick dark' }));
    expect(storage.read()).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');

    fireEvent.click(screen.getByRole('button', { name: 'pick light' }));
    expect(storage.read()).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('removes the override in system mode so the OS preference applies', () => {
    const storage = fakeStorage('dark');
    render(
      <ThemeProvider storage={storage}>
        <Probe />
      </ThemeProvider>
    );
    expect(document.documentElement.dataset.theme).toBe('dark');

    fireEvent.click(screen.getByRole('button', { name: 'pick system' }));
    expect(storage.read()).toBe('system');
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(screen.getByTestId('choice')).toHaveTextContent('system');
  });

  it('tracks OS changes while in system mode', () => {
    const media: { listener: ((event: MediaQueryListEvent) => void) | null } = { listener: null };
    const query = {
      matches: false,
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addEventListener: (_: string, callback: (event: MediaQueryListEvent) => void) => {
        media.listener = callback;
      },
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    };
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: () => query });

    render(
      <ThemeProvider storage={fakeStorage()}>
        <Probe />
      </ThemeProvider>
    );
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');

    query.matches = true;
    act(() => {
      media.listener?.({ matches: true } as MediaQueryListEvent);
    });

    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});
