import type { GalleryAsset } from './types';

const DAY_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

const FULL_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** Parses an ISO timestamp, returning null for missing or unparsable values. */
export function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The date a timeline entry belongs to: capture time when it is valid, the
 * indexing time otherwise. Unparsable values fall back to the epoch so an entry
 * is never dropped from the gallery.
 */
export function assetDate(asset: Pick<GalleryAsset, 'takenAt' | 'addedAt'>): Date {
  return toDate(asset.takenAt) ?? toDate(asset.addedAt) ?? new Date(0);
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Stable local-calendar key, e.g. `2024-01-15`. */
export function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function formatDate(date: Date): string {
  return DAY_FORMAT.format(date);
}

export function formatDateTime(date: Date): string {
  return FULL_FORMAT.format(date);
}

/** "Today", "Yesterday" or a short calendar date. */
export function dayLabel(date: Date, now: Date = new Date()): string {
  if (sameDay(date, now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return 'Yesterday';
  return formatDate(date);
}

export interface DayGroup {
  key: string;
  label: string;
  date: Date;
  assets: GalleryAsset[];
}

/**
 * Groups assets into labelled days. Input order is preserved inside a group, and
 * groups keep the order in which they first appear, so the caller's newest-first
 * ordering survives grouping.
 */
export function groupAssetsByDay(
  assets: readonly GalleryAsset[],
  now: Date = new Date()
): DayGroup[] {
  const groups = new Map<string, DayGroup>();
  for (const asset of assets) {
    const date = assetDate(asset);
    const key = dayKey(date);
    const existing = groups.get(key);
    if (existing) {
      existing.assets.push(asset);
    } else {
      groups.set(key, { key, label: dayLabel(date, now), date, assets: [asset] });
    }
  }
  return [...groups.values()];
}
