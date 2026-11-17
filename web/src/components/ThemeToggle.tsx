import { useTheme } from '@xue-mint/shared';
import type { ThemeChoice } from '@xue-mint/shared';

const OPTIONS: Array<{ value: ThemeChoice; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** Persistent light/dark/system choice; system follows the OS live. */
export function ThemeToggle() {
  const { choice, setChoice } = useTheme();

  return (
    <div className="theme-toggle" role="group" aria-label="Color theme">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={choice === option.value ? 'theme-toggle__option is-active' : 'theme-toggle__option'}
          aria-pressed={choice === option.value}
          onClick={() => setChoice(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
