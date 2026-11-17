import { formatDateTime, toDate } from '@xue-mint/shared';

/** Formats a server timestamp, with an explicit placeholder for missing values. */
export function formatTimestamp(value: string | null | undefined, fallback = 'Not yet'): string {
  const date = toDate(value);
  return date ? formatDateTime(date) : fallback;
}
