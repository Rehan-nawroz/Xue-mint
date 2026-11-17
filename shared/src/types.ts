/** A single photo or video as the gallery needs it, independent of the transport. */
export type AssetType = 'photo' | 'video';

export interface GalleryAsset {
  id: string;
  type: AssetType;
  filename: string | null;
  /** Capture time from metadata, when the file carries it. */
  takenAt: string | null;
  /** When the server indexed the file. Always present. */
  addedAt: string;
  width: number | null;
  height: number | null;
  size?: number;
  /**
   * Same-origin thumbnail URL. The shared package never fetches it itself, so
   * each host (web gallery, mobile app) decides how authentication works.
   */
  thumbUrl: string;
  /** Same-origin URL of the original file. */
  originalUrl: string;
}

export function isVideo(asset: Pick<GalleryAsset, 'type'>): boolean {
  return asset.type === 'video';
}
