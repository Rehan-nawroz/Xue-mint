import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PhotoGrid, buildGridLayout, columnsForWidth, groupAssetsByDay } from '@xue-mint/shared';
import { makeAsset, makeAssets } from '../test/fixtures';

describe('grid layout', () => {
  it('computes responsive column counts from the available width', () => {
    expect(columnsForWidth(1024)).toBe(6);
    expect(columnsForWidth(320)).toBe(2);
    expect(columnsForWidth(120)).toBe(1);
  });

  it('flattens day groups into header and tile rows', () => {
    const groups = groupAssetsByDay(makeAssets(10, 1), new Date('2024-03-01'));
    const layout = buildGridLayout(groups, 1000);

    expect(layout.rows[0].kind).toBe('header');
    expect(layout.rows[1].kind).toBe('tiles');
    expect(layout.columns).toBe(6);
    expect(layout.totalHeight).toBeGreaterThan(0);
  });
});

describe('PhotoGrid', () => {
  it('keeps the rendered DOM bounded for a 5,000 item library', () => {
    const assets = makeAssets(5000, 1);
    const { container } = render(<PhotoGrid assets={assets} onOpen={() => undefined} />);

    const tiles = container.querySelectorAll('.xm-tile');
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThan(150);
    expect(assets.length).toBe(5000);
  });

  it('shows the pinned date and updates it while scrolling', () => {
    const assets = makeAssets(16, 15);
    const { container } = render(<PhotoGrid assets={assets} onOpen={() => undefined} />);

    const pin = container.querySelector('.xm-grid__pin');
    expect(pin).toHaveTextContent('Jan 15, 2024');

    const scroller = container.querySelector('.xm-grid__scroll');
    expect(scroller).not.toBeNull();
    Object.defineProperty(scroller as HTMLElement, 'scrollTop', {
      configurable: true,
      value: 500,
    });
    fireEvent.scroll(scroller as HTMLElement);

    expect(pin).toHaveTextContent('Jan 16, 2024');
  });

  it('insets tile rows and date headers from the page edge', () => {
    const assets = makeAssets(4, 15);
    const { container } = render(<PhotoGrid assets={assets} onOpen={() => undefined} />);

    const row = container.querySelector<HTMLElement>('.xm-grid__row');
    const date = container.querySelector<HTMLElement>('.xm-grid__date');
    expect(row).not.toBeNull();
    expect(row?.style.left).toBe('16px');
    expect(row?.style.right).toBe('16px');
    expect(date?.style.left).toBe('16px');
    expect(date?.style.right).toBe('16px');
  });

  it('opens the selected asset with its timeline index', () => {
    const assets = makeAssets(4, 15);
    const onOpen = vi.fn();
    const { container } = render(<PhotoGrid assets={assets} onOpen={onOpen} />);

    const first = container.querySelector<HTMLButtonElement>('.xm-tile');
    expect(first).not.toBeNull();
    expect(first).toHaveAccessibleName(/Photo: IMG_0\.jpg/);
    fireEvent.click(first as HTMLButtonElement);

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][0].id).toBe(assets[0].id);
    expect(onOpen.mock.calls[0][1]).toBe(0);
  });

  it('falls back to a stable tile when a thumbnail fails', () => {
    const assets = [makeAsset({ id: 'broken' })];
    const { container } = render(<PhotoGrid assets={assets} onOpen={() => undefined} />);

    const image = container.querySelector('.xm-tile__image');
    expect(image).not.toBeNull();
    fireEvent.error(image as HTMLElement);
    expect(container.querySelector('.xm-tile__fallback')).not.toBeNull();
  });

  it('renders the provided empty state instead of an empty grid', () => {
    render(
      <PhotoGrid
        assets={[]}
        onOpen={() => undefined}
        emptyState={<p>Nothing here yet</p>}
      />
    );
    expect(screen.getByText('Nothing here yet')).toBeInTheDocument();
  });
});
