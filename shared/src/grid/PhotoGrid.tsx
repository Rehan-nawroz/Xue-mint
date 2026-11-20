import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { assetDate, formatDateTime, groupAssetsByDay } from '../dates';
import type { GalleryAsset } from '../types';
import { isVideo } from '../types';
import {
  DEFAULT_GAP,
  DEFAULT_HEADER_HEIGHT,
  DEFAULT_MIN_TILE,
  buildGridLayout,
  pinnedLabel,
  visibleRowRange,
} from './layout';

export interface PhotoGridProps {
  assets: readonly GalleryAsset[];
  onOpen: (asset: GalleryAsset, index: number) => void;
  /** Rendered instead of the grid when there are no assets. */
  emptyState?: ReactNode;
  ariaLabel?: string;
  minTileSize?: number;
  gap?: number;
  headerHeight?: number;
  overscan?: number;
  /** Called when the user scrolls close to the end of the loaded rows. */
  onEndReached?: () => void;
  /** Side inset that aligns tiles with the surrounding page chrome. */
  horizontalPadding?: number;
  /** Shows the file-name line under each tile. Mobile timelines usually hide it. */
  showCaptions?: boolean;
  /** Fallback measurements for environments without ResizeObserver. */
  initialWidth?: number;
  initialViewportHeight?: number;
  className?: string;
  /**
   * Optional small indicator drawn over each tile, e.g. a backup state.
   * Rendered only when the tile's badge key changes, so stateful grids do
   * not re-render every tile on scroll.
   */
  tileBadge?: (asset: GalleryAsset) => ReactNode;
  tileBadgeKey?: (asset: GalleryAsset) => string;
}

function describeAsset(asset: GalleryAsset): string {
  const name = asset.filename?.trim() || (isVideo(asset) ? 'Untitled video' : 'Untitled photo');
  const kind = isVideo(asset) ? 'Video' : 'Photo';
  return `${kind}: ${name}, ${formatDateTime(assetDate(asset))}`;
}

interface TileProps {
  asset: GalleryAsset;
  index: number;
  onOpen: (asset: GalleryAsset, index: number) => void;
  onStepFocus: (index: number, direction: -1 | 1) => void;
  showCaption: boolean;
  badge?: ReactNode;
  badgeKey?: string;
}

const Tile = memo(
  function Tile({
    asset,
    index,
    onOpen,
    onStepFocus,
    showCaption,
    badge,
  }: TileProps) {
    const [failed, setFailed] = useState(false);
    const name = asset.filename?.trim() || (isVideo(asset) ? 'Untitled video' : 'Untitled photo');

    return (
      <button
        type="button"
        className="xm-tile"
        data-xm-tile={index}
        aria-label={describeAsset(asset)}
        onClick={() => onOpen(asset, index)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            onStepFocus(index, 1);
          } else if (event.key === 'ArrowLeft') {
            event.preventDefault();
            onStepFocus(index, -1);
          }
        }}
      >
        <span className="xm-tile__media">
          {failed ? (
            <span className="xm-tile__fallback" aria-hidden="true">
              <span className="xm-tile__fallback-mark" />
            </span>
          ) : (
            <img
              className="xm-tile__image"
              src={asset.thumbUrl}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setFailed(true)}
            />
          )}
          {isVideo(asset) ? (
            <span className="xm-tile__badge" aria-hidden="true">
              ▶
            </span>
          ) : null}
          {badge != null ? (
            <span className="xm-tile__flag" aria-hidden="true">
              {badge}
            </span>
          ) : null}
        </span>
        {showCaption ? (
          <span className="xm-tile__name" title={name}>
            {name}
          </span>
        ) : null}
      </button>
    );
  },
  (previous, next) =>
    previous.asset === next.asset &&
    previous.index === next.index &&
    previous.onOpen === next.onOpen &&
    previous.onStepFocus === next.onStepFocus &&
    previous.showCaption === next.showCaption &&
    previous.badgeKey === next.badgeKey
);

/**
 * Date-grouped, virtualized square-tile grid. Only the rows intersecting the
 * viewport (plus a small overscan) are mounted, so a 5,000-item library keeps a
 * bounded DOM. A pinned bar shows the date of the topmost visible group.
 */
export function PhotoGrid({
  assets,
  onOpen,
  emptyState = null,
  ariaLabel = 'Photo timeline',
  minTileSize = DEFAULT_MIN_TILE,
  gap = DEFAULT_GAP,
  headerHeight = DEFAULT_HEADER_HEIGHT,
  overscan = 3,
  onEndReached,
  horizontalPadding = 16,
  showCaptions = true,
  initialWidth = 1024,
  initialViewportHeight = 800,
  className,
  tileBadge,
  tileBadgeKey,
}: PhotoGridProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(initialWidth);
  const [viewportHeight, setViewportHeight] = useState(initialViewportHeight);
  const [scrollTop, setScrollTop] = useState(0);

  const groups = useMemo(() => groupAssetsByDay([...assets]), [assets]);
  const contentWidth = Math.max(1, width - horizontalPadding * 2);
  const layout = useMemo(
    () =>
      buildGridLayout(groups, contentWidth, {
        minTileSize,
        gap,
        headerHeight,
        captionHeight: showCaptions ? undefined : 0,
      }),
    [groups, contentWidth, minTileSize, gap, headerHeight, showCaptions]
  );
  const range = visibleRowRange(layout.rows, scrollTop, viewportHeight, overscan);
  const label = pinnedLabel(layout.rows, scrollTop);

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const nextWidth = entry.contentRect.width;
      const nextHeight = entry.contentRect.height;
      if (nextWidth > 0) setWidth(nextWidth);
      if (nextHeight > 0) setViewportHeight(nextHeight);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (element.clientHeight > 0) setViewportHeight(element.clientHeight);
    if (element.clientWidth > 0) setWidth(element.clientWidth);
  }, []);

  if (assets.length === 0) {
    return <>{emptyState}</>;
  }

  const stepFocus = (index: number, direction: -1 | 1) => {
    const next = index + direction;
    const root = scrollRef.current;
    if (!root) return;
    const target = root.querySelector<HTMLButtonElement>(`[data-xm-tile="${next}"]`);
    target?.focus();
  };

  const visibleRows = layout.rows.slice(range.start, range.end);
  const canvasStyle: CSSProperties = { height: layout.totalHeight };

  return (
    <div className={className ? `xm-grid ${className}` : 'xm-grid'}>
      <div className="xm-grid__pin" aria-hidden="true">
        {label}
      </div>
      <div
        ref={scrollRef}
        className="xm-grid__scroll"
        role="region"
        aria-label={ariaLabel}
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          setScrollTop(element.scrollTop);
          if (
            onEndReached &&
            element.scrollHeight - (element.scrollTop + element.clientHeight) < 800
          ) {
            onEndReached();
          }
        }}
      >
        <div className="xm-grid__canvas" style={canvasStyle}>
          {visibleRows.map((row) =>
            row.kind === 'header' ? (
              <h3
                key={row.key}
                className="xm-grid__date"
                style={{
                  top: row.top,
                  left: horizontalPadding,
                  right: horizontalPadding,
                  height: row.height,
                }}
              >
                {row.label}
              </h3>
            ) : (
              <div
                key={row.key}
                className="xm-grid__row"
                style={{
                  top: row.top,
                  left: horizontalPadding,
                  right: horizontalPadding,
                  height: row.height,
                  gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`,
                  gap,
                }}
              >
                {row.items.map(({ asset, index }) => (
                  <Tile
                    key={asset.id}
                    asset={asset}
                    index={index}
                    onOpen={onOpen}
                    onStepFocus={stepFocus}
                    showCaption={showCaptions}
                    badge={tileBadge?.(asset)}
                    badgeKey={tileBadgeKey?.(asset)}
                  />
                ))}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}

// Keeps the exported keyboard handler type available to hosts that wrap the grid.
export type GridKeyEvent = KeyboardEvent<HTMLElement>;
