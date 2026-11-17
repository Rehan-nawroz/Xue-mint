import type { GalleryAsset } from './types';

/**
 * Appends a timeline page without duplicating assets that are already shown.
 * Cursors can overlap when files are indexed between page requests, so the merge
 * is by stable asset id rather than by position.
 */
export function mergeTimelinePage(
  existing: readonly GalleryAsset[],
  incoming: readonly GalleryAsset[]
): GalleryAsset[] {
  const seen = new Set(existing.map((asset) => asset.id));
  const merged = existing.slice();
  for (const asset of incoming) {
    if (seen.has(asset.id)) continue;
    seen.add(asset.id);
    merged.push(asset);
  }
  return merged;
}
