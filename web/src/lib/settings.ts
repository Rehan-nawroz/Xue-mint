import type { DeleteBehavior, ServerSettings } from '../api/types';

export interface SettingsForm {
  photosFolder: string;
  deleteBehavior: DeleteBehavior;
  port: string;
}

export interface SettingsFormErrors {
  photosFolder?: string;
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
  return Boolean(errors.photosFolder || errors.port);
}

export function formFromSettings(settings: ServerSettings): SettingsForm {
  return {
    photosFolder: settings.photosFolder,
    deleteBehavior: settings.deleteBehavior,
    port: String(settings.port),
  };
}
