import { describe, expect, it } from 'vitest';
import { assetDate, dayKey, dayLabel, groupAssetsByDay } from '@xue-mint/shared';
import { makeAsset } from '../test/fixtures';

describe('assetDate', () => {
  it('uses the capture date when present', () => {
    const asset = makeAsset({
      id: 'a',
      takenAt: '2024-02-03T08:00:00',
      addedAt: '2024-06-01T09:00:00',
    });
    expect(assetDate(asset).getMonth()).toBe(1);
    expect(assetDate(asset).getDate()).toBe(3);
  });

  it('falls back to the indexing date when capture time is missing', () => {
    const asset = makeAsset({ id: 'a', takenAt: null, addedAt: '2024-06-01T09:00:00' });
    expect(dayKey(assetDate(asset))).toBe('2024-06-01');
  });

  it('falls back to the indexing date when capture time is unparsable', () => {
    const asset = makeAsset({ id: 'a', takenAt: 'not-a-date', addedAt: '2024-06-01T09:00:00' });
    expect(dayKey(assetDate(asset))).toBe('2024-06-01');
  });
});

describe('groupAssetsByDay', () => {
  it('splits on local calendar boundaries', () => {
    const late = makeAsset({ id: 'late', takenAt: '2024-01-15T23:59:00' });
    const early = makeAsset({ id: 'early', takenAt: '2024-01-16T00:01:00' });
    const groups = groupAssetsByDay([late, early], new Date('2024-03-01T12:00:00'));

    expect(groups).toHaveLength(2);
    expect(groups[0].key).toBe('2024-01-15');
    expect(groups[1].key).toBe('2024-01-16');
    expect(groups[0].assets.map((asset) => asset.id)).toEqual(['late']);
  });

  it('keeps input order inside a group and first-seen group order', () => {
    const first = makeAsset({ id: 'first', takenAt: '2024-01-16T10:00:00' });
    const second = makeAsset({ id: 'second', takenAt: '2024-01-16T09:00:00' });
    const older = makeAsset({ id: 'older', takenAt: '2024-01-14T09:00:00' });
    const groups = groupAssetsByDay([first, second, older], new Date('2024-03-01'));

    expect(groups.map((group) => group.key)).toEqual(['2024-01-16', '2024-01-14']);
    expect(groups[0].assets.map((asset) => asset.id)).toEqual(['first', 'second']);
  });

  it('labels today and yesterday relative to the given clock', () => {
    const now = new Date('2024-05-10T12:00:00');
    const today = makeAsset({ id: 'today', takenAt: '2024-05-10T08:00:00' });
    const yesterday = makeAsset({ id: 'yesterday', takenAt: '2024-05-09T08:00:00' });
    const older = makeAsset({ id: 'older', takenAt: '2024-05-02T08:00:00' });

    const groups = groupAssetsByDay([today, yesterday, older], now);
    expect(groups.map((group) => group.label)).toEqual(['Today', 'Yesterday', 'May 2, 2024']);
  });

  it('returns an empty list for an empty library', () => {
    expect(groupAssetsByDay([], new Date('2024-01-01'))).toEqual([]);
    expect(dayLabel(new Date('2024-01-01'), new Date('2024-01-01'))).toBe('Today');
  });
});
