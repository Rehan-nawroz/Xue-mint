import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@xue-mint/shared';
import { App } from '../App';
import { GalleryApiError } from '../api/types';
import { defaultStatus, makeApi, makeAssets } from '../test/fixtures';

function renderApp(api = makeApi()) {
  return render(
    <ThemeProvider>
      <App api={api} />
    </ThemeProvider>
  );
}

describe('App', () => {
  it('shows the offline state when the server is unreachable', async () => {
    const api = makeApi({
      fetchTimeline: async () => {
        throw new GalleryApiError(0, 'NETWORK', 'offline');
      },
    });
    renderApp(api);
    expect(await screen.findByText("Can't reach the server")).toBeInTheDocument();
  });

  it('shows the unlock guidance for an unauthenticated browser', async () => {
    const api = makeApi({
      fetchTimeline: async () => {
        throw new GalleryApiError(401, 'AUTH_REQUIRED', 'Pair first.');
      },
    });
    renderApp(api);
    expect(await screen.findByText('Unlock the gallery on this PC')).toBeInTheDocument();
  });

  it('shows the empty library state with a refresh action', async () => {
    const api = makeApi();
    renderApp(api);
    expect(await screen.findByText('No photos yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });

  it('renders the timeline and opens a photo in the viewer', async () => {
    const assets = makeAssets(4, 15);
    const api = makeApi({
      fetchTimeline: async () => ({ items: assets, nextCursor: null }),
      fetchStatus: async () => defaultStatus,
    });
    renderApp(api);

    const tiles = await screen.findAllByRole('button', { name: /Photo: IMG_/ });
    expect(tiles.length).toBeGreaterThan(0);
    fireEvent.click(tiles[0]);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('searches the timeline by file name', async () => {
    const assets = makeAssets(4, 15);
    const fetchTimeline = vi.fn(
      async (_cursor: string | null = null, _limit = 200, query = '') => ({
        items: assets.filter((asset) =>
          (asset.filename ?? '').toLowerCase().includes(query.toLowerCase())
        ),
        nextCursor: null,
      })
    );
    const api = makeApi({ fetchTimeline, fetchStatus: async () => defaultStatus });
    renderApp(api);

    await screen.findAllByRole('button', { name: /Photo: IMG_/ });
    fireEvent.change(screen.getByLabelText('Search photos by file name'), {
      target: { value: 'IMG_2' },
    });

    expect(await screen.findByRole('button', { name: /Photo: IMG_2.jpg/ })).toBeInTheDocument();
    await waitFor(() => expect(fetchTimeline).toHaveBeenLastCalledWith(null, 200, 'IMG_2'));
    expect(screen.getAllByRole('button', { name: /Photo: IMG_/ })).toHaveLength(1);
    expect(screen.getByText('1 match')).toBeInTheDocument();
  });

  it('clears a search that has no matches', async () => {
    const assets = makeAssets(2, 15);
    const fetchTimeline = vi.fn(async (_cursor: string | null = null, _limit = 200, query = '') => ({
      items: assets.filter((asset) => (asset.filename ?? '').includes(query)),
      nextCursor: null,
    }));
    const api = makeApi({ fetchTimeline, fetchStatus: async () => defaultStatus });
    renderApp(api);

    await screen.findAllByRole('button', { name: /Photo: IMG_/ });
    fireEvent.change(screen.getByLabelText('Search photos by file name'), {
      target: { value: 'nothing-matches' },
    });

    expect(await screen.findByText(/No photos match/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all photos' }));
    expect(await screen.findAllByRole('button', { name: /Photo: IMG_/ })).toHaveLength(2);
  });

  it('switches to the settings view', async () => {
    const api = makeApi({
      fetchTimeline: async () => ({ items: makeAssets(2, 15), nextCursor: null }),
      fetchStatus: async () => defaultStatus,
    });
    renderApp(api);
    await screen.findAllByRole('button', { name: /Photo: IMG_/ });

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByLabelText('Photos folder')).toBeInTheDocument();
    expect(vi.isMockFunction(api.fetchSettings)).toBe(false);
  });
});
