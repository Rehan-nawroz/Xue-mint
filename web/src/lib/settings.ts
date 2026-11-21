import type { DeleteBehavior, ServerSettings } from '../api/types';

export interface SettingsForm {
  photosFolder: string;
  deleteBehavior: DeleteBehavior;
  mirrorFolder: string;
  port: string;
}

export interface SettingsFormErrors {
  photosFolder?: string;
  mirrorFolder?: string;
  port?: string;
}

const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/;
const UNC_ABSOLUTE = /^\\\\[^\\]+\\/;

/** Full path on Windows (`D:\Photos`) or on a Unix-like host (`/photos`). */
export function isAbsoluteFolderPath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return trimmed.startsWith('/') || WINDOWS_ABSOLUTE.test(trimmed) || UNC_ABSOLUTE.test(trimmed);
}

export function validateSettings(values: SettingsForm): SettingsFormErrors {
  const errors: SettingsFormErrors = {};

  if (!values.photosFolder.trim()) {
    errors.photosFolder = 'Enter the photos folder path.';
  } else if (!isAbsoluteFolderPath(values.photosFolder)) {
    errors.photosFolder = 'Use a full path, for example D:\\Photos.';
  }

  const mirror = values.mirrorFolder.trim();
  if (mirror) {
    if (!isAbsoluteFolderPath(mirror)) {
      errors.mirrorFolder = 'Use a full path, for example E:\\PhotoBackup.';
    } else if (normalizeFolder(mirror) === normalizeFolder(values.photosFolder)) {
      errors.mirrorFolder = 'Choose a folder different from the photos folder.';
    }
  }

  const portText = values.port.trim();
  if (!portText) {
    errors.port = 'Enter a port between 1024 and 65535.';
  } else {
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      errors.port = 'Choose a whole number between 1024 and 65535.';
    }
  }

  return errors;
}

export function hasSettingsErrors(errors: SettingsFormErrors): boolean {
  return Boolean(errors.photosFolder || errors.mirrorFolder || errors.port);
}

function normalizeFolder(value: string): string {
  return value.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

export function formFromSettings(settings: ServerSettings): SettingsForm {
  return {
    photosFolder: settings.photosFolder,
    deleteBehavior: settings.deleteBehavior,
    mirrorFolder: settings.mirrorFolder,
    port: String(settings.port),
  };
}
