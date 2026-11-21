import { useRef, useState } from 'react';
import logoUrl from '../../assets/brand/mock-logo.svg';
import { Viewer } from '@xue-mint/shared';
import type { GalleryAsset } from '@xue-mint/shared';
import { createApi } from './api';
import type { GalleryApi } from './api/types';
import { DevicesPage } from './components/DevicesPage';
import { SettingsPage } from './components/SettingsPage';
import { StatusBar } from './components/StatusBar';
import { ThemeToggle } from './components/ThemeToggle';
import { TimelineView } from './components/TimelineView';
import { useStatus } from './hooks/useStatus';
import { useTimeline } from './hooks/useTimeline';

export type AppView = 'photos' | 'devices' | 'settings';

const TABS: Array<{ id: AppView; label: string }> = [
  { id: 'photos', label: 'Photos' },
  { id: 'devices', label: 'Devices' },
  { id: 'settings', label: 'Settings' },
];

interface AppProps {
  /** Injectable backend, used by tests; defaults to the real server. */
  api?: GalleryApi;
}

export function App({ api: providedApi }: AppProps = {}) {
  const [api] = useState<GalleryApi>(() => providedApi ?? createApi());
  const [view, setView] = useState<AppView>('photos');
  const [search, setSearch] = useState('');
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const timeline = useTimeline(api, search);
  const status = useStatus(api);

  const addPhotos = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setAdding(`Adding ${files.length} file(s)…`);
    try {
      const result = await api.importFiles(Array.from(files));
      setAdding(
        result.imported === 0 && result.duplicates > 0
          ? 'Already in your library.'
          : `Added ${result.imported} file(s)${result.duplicates > 0 ? ` · ${result.duplicates} already present` : ''}.`
      );
      timeline.retry();
      status.refresh();
    } catch {
      setAdding('Adding failed — try again.');
    } finally {
      if (fileInput.current) fileInput.current.value = '';
      window.setTimeout(() => setAdding(null), 4000);
    }
  };

  const openViewer = (_asset: GalleryAsset, index: number) => {
    setViewerIndex(index);
  };

  const deleteAsset = async (asset: GalleryAsset) => {
    await api.deleteAsset(asset.id);
    timeline.removeAsset(asset.id);
    status.refresh();
  };

  const renameAsset = async (asset: GalleryAsset, filename: string) => {
    const saved = await api.renameAsset(asset.id, filename);
    timeline.renameAsset(asset.id, saved);
    return saved;
  };

  const activeIndex =
    viewerIndex === null
      ? null
      : Math.min(Math.max(viewerIndex, 0), Math.max(timeline.assets.length - 1, 0));

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img className="brand__logo" src={logoUrl} alt="" width={30} height={30} />
          <span className="brand__name">Xue-Mint</span>
          {api.mode === 'mock' ? <span className="badge badge--muted">Sample data</span> : null}
        </div>

        <button
          type="button"
          className="add-photos-button"
          disabled={adding !== null}
          onClick={() => fileInput.current?.click()}
        >
          + Add photos
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*,video/*"
          multiple
          hidden
          onChange={(event) => void addPhotos(event.target.files)}
        />

        <nav className="nav" aria-label="Main">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={view === tab.id ? 'nav__tab is-active' : 'nav__tab'}
              aria-current={view === tab.id ? 'page' : undefined}
              onClick={() => setView(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <ThemeToggle />
      </header>

      {adding ? (
        <div className="add-status" role="status">
          {adding}
        </div>
      ) : null}

      <main className="app__main">
        {view === 'photos' ? (
          <>
            <StatusBar
              status={status.status}
              loading={status.loading}
              error={status.error}
              onRetry={status.refresh}
            />
            <TimelineView
              timeline={timeline}
              onOpen={openViewer}
              query={search}
              onQueryChange={setSearch}
            />
          </>
        ) : view === 'devices' ? (
          <DevicesPage api={api} />
        ) : (
          <SettingsPage api={api} />
        )}
      </main>

      {activeIndex !== null && timeline.assets[activeIndex] ? (
        <Viewer
          assets={timeline.assets}
          index={activeIndex}
          onClose={() => setViewerIndex(null)}
          onIndexChange={setViewerIndex}
          onDelete={deleteAsset}
          onRename={renameAsset}
        />
      ) : null}
    </div>
  );
}
