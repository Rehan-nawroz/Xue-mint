import type { DayGroup } from '../dates';
import type { GalleryAsset } from '../types';

export const DEFAULT_HEADER_HEIGHT = 40;
export const DEFAULT_GAP = 4;
export const DEFAULT_MIN_TILE = 120;

export interface HeaderRow {
  kind: 'header';
  key: string;
  label: string;
  groupKey: string;
  top: number;
  height: number;
}

export interface TilesRow {
  kind: 'tiles';
  key: string;
  top: number;
  height: number;
  items: Array<{ asset: GalleryAsset; index: number }>;
}

export type GridRow = HeaderRow | TilesRow;

export interface GridLayout {
  rows: GridRow[];
  totalHeight: number;
  columns: number;
  tileSize: number;
}

/** Number of square tiles that fit across `width`. */
export function columnsForWidth(
  width: number,
  minTileSize: number = DEFAULT_MIN_TILE,
  gap: number = DEFAULT_GAP
): number {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : minTileSize + gap;
  return Math.max(1, Math.floor((safeWidth + gap) / (minTileSize + gap)));
}

/**
 * Flattens day groups into fixed-height virtual rows: one header row per day,
 * followed by tile rows. Positions are absolute so the grid can render only the
 * rows inside the viewport.
 */
export function buildGridLayout(
  groups: readonly DayGroup[],
  width: number,
  options: {
    minTileSize?: number;
    gap?: number;
    headerHeight?: number;
  } = {}
): GridLayout {
  const minTileSize = options.minTileSize ?? DEFAULT_MIN_TILE;
  const gap = options.gap ?? DEFAULT_GAP;
  const headerHeight = options.headerHeight ?? DEFAULT_HEADER_HEIGHT;
  const columns = columnsForWidth(width, minTileSize, gap);
  const tileSize = Math.max(
    1,
    Math.floor((Math.max(width, columns * minTileSize) - gap * (columns - 1)) / columns)
  );

  const rows: GridRow[] = [];
  let top = 0;
  let index = 0;

  for (const group of groups) {
    const header: HeaderRow = {
      kind: 'header',
      key: `header-${group.key}`,
      label: group.label,
      groupKey: group.key,
      top,
      height: headerHeight,
    };
    rows.push(header);
    top += headerHeight + gap;

    for (let start = 0; start < group.assets.length; start += columns) {
      const slice = group.assets.slice(start, start + columns);
      const tiles: TilesRow = {
        kind: 'tiles',
        key: `tiles-${group.key}-${start}`,
        top,
        height: tileSize,
        items: slice.map((asset) => ({ asset, index: index++ })),
      };
      rows.push(tiles);
      top += tileSize + gap;
    }
  }

  return { rows, totalHeight: Math.max(0, top - gap), columns, tileSize };
}

export interface VisibleRange {
  start: number;
  end: number;
}

/**
 * Index range of rows that intersect the viewport, expanded by `overscan` rows
 * on both sides and clamped to the layout.
 */
export function visibleRowRange(
  rows: readonly GridRow[],
  scrollTop: number,
  viewportHeight: number,
  overscan = 3
): VisibleRange {
  if (rows.length === 0) return { start: 0, end: 0 };
  const top = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  const height = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
  const bottom = top + height;

  let first = 0;
  while (first < rows.length && rows[first].top + rows[first].height < top) first += 1;

  let last = first;
  while (last < rows.length && rows[last].top <= bottom) last += 1;

  const start = Math.max(0, first - overscan);
  const end = Math.min(rows.length, last + overscan);
  return { start, end: Math.max(start, end) };
}

/** Label of the day that owns the top edge of the viewport. */
export function pinnedLabel(
  rows: readonly GridRow[],
  scrollTop: number
): string | null {
  let label: string | null = null;
  for (const row of rows) {
    if (row.kind !== 'header') continue;
    if (row.top > scrollTop + 1) break;
    label = row.label;
  }
  return label;
}
