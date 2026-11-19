import { LibraryIcon, PhotosIcon, SettingsIcon } from './icons';

export type AppScreen = 'photos' | 'library' | 'settings';

const TABS: Array<{
  id: AppScreen;
  label: string;
  Icon: typeof PhotosIcon;
}> = [
  { id: 'photos', label: 'Photos', Icon: PhotosIcon },
  { id: 'library', label: 'Library', Icon: LibraryIcon },
  { id: 'settings', label: 'Settings', Icon: SettingsIcon },
];

interface BottomNavProps {
  active: AppScreen;
  onChange: (screen: AppScreen) => void;
}

export function BottomNav({ active, onChange }: BottomNavProps) {
  return (
    <nav
      className="safe-bottom flex-none border-t border-line bg-surface"
      aria-label="Main"
    >
      <div className="flex" style={{ height: 'var(--nav-height)' }}>
        {TABS.map(({ id, label, Icon }) => {
          const selected = active === id;
          return (
            <button
              key={id}
              type="button"
              className={`flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors ${
                selected ? 'text-brand' : 'text-muted hover:text-ink'
              }`}
              aria-current={selected ? 'page' : undefined}
              aria-label={label}
              onClick={() => onChange(id)}
            >
              <span
                className={`flex h-7 w-12 items-center justify-center rounded-full transition-colors ${
                  selected ? 'bg-brand/12' : ''
                }`}
              >
                <Icon className="h-[22px] w-[22px]" />
              </span>
              {label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
