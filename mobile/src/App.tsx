import { useMemo, useState } from 'react';
import { Viewer } from '@xue-mint/shared';
import { AppScreen, BottomNav } from './components/BottomNav';
import { PairPcDialog } from './components/PairPcDialog';
import { createDiagnostics, createEngine } from './engine';
import { useEngineSettings, useEngineStatus, useTimeline } from './hooks/useEngineData';
import { LibraryScreen } from './screens/LibraryScreen';
import { PhotosScreen } from './screens/PhotosScreen';
import { SettingsScreen } from './screens/SettingsScreen';

export function App() {
  const engine = useMemo(() => createEngine(), []);
  const diagnostics = useMemo(() => createDiagnostics(), []);
  const [screen, setScreen] = useState<AppScreen>('photos');
  const [pairOpen, setPairOpen] = useState(false);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  const statusState = useEngineStatus(engine);
  const settingsState = useEngineSettings(engine);
  const timeline = useTimeline(engine);

  const activeIndex =
    viewerIndex === null
      ? null
      : Math.min(Math.max(viewerIndex, 0), Math.max(timeline.assets.length - 1, 0));

  const handlePair = async (payload: string) => {
    await engine.pairWithQr(payload);
    statusState.refresh();
  };

  const handleBackupNow = async () => {
    await engine.startBackup();
    await statusState.refresh();
  };

  return (
    <div className="app-shell text-ink">
      <main className="flex min-h-0 flex-1 flex-col">
        {screen === 'photos' ? (
          <PhotosScreen
            timeline={timeline}
            status={statusState.status}
            statusLoading={statusState.loading}
            statusError={statusState.error}
            onRefreshStatus={statusState.refresh}
            onPair={() => setPairOpen(true)}
            onOpen={(_asset, index) => setViewerIndex(index)}
          />
        ) : screen === 'library' ? (
          <LibraryScreen
            status={statusState.status}
            mode={engine.mode}
            onPair={() => setPairOpen(true)}
          />
        ) : (
          <SettingsScreen
            engine={engine}
            status={statusState.status}
            settings={settingsState.settings}
            settingsError={settingsState.error}
            saving={settingsState.saving}
            onSettingsChange={settingsState.save}
            onPair={() => setPairOpen(true)}
            onRetryStatus={statusState.refresh}
            onBackupNow={handleBackupNow}
            diagnostics={diagnostics}
          />
        )}
      </main>

      <BottomNav active={screen} onChange={setScreen} />

      {activeIndex !== null && timeline.assets[activeIndex] ? (
        <Viewer
          assets={timeline.assets}
          index={activeIndex}
          onClose={() => setViewerIndex(null)}
          onIndexChange={setViewerIndex}
        />
      ) : null}

      <PairPcDialog
        open={pairOpen}
        mode={engine.mode}
        onClose={() => setPairOpen(false)}
        onPair={handlePair}
      />
    </div>
  );
}
