import { describe, expect, it } from 'vitest';
import {
  formFromSettings,
  hasSettingsErrors,
  isAbsoluteFolderPath,
  validateSettings,
} from '../lib/settings';
import { defaultSettings } from '../test/fixtures';

describe('settings validation', () => {
  it('accepts absolute Windows, UNC and Unix paths only', () => {
    expect(isAbsoluteFolderPath('D:\\Photos')).toBe(true);
    expect(isAbsoluteFolderPath('C:/Photos')).toBe(true);
    expect(isAbsoluteFolderPath('\\\\server\\share\\photos')).toBe(true);
    expect(isAbsoluteFolderPath('/home/me/photos')).toBe(true);
    expect(isAbsoluteFolderPath('Photos')).toBe(false);
    expect(isAbsoluteFolderPath('..\\Photos')).toBe(false);
    expect(isAbsoluteFolderPath('   ')).toBe(false);
  });

  it('rejects an empty or relative folder', () => {
    expect(validateSettings({ photosFolder: '', deleteBehavior: 'index_only', port: '8427' }))
      .toEqual({ photosFolder: 'Enter the photos folder path.' });
    expect(
      validateSettings({ photosFolder: 'Photos', deleteBehavior: 'index_only', port: '8427' })
        .photosFolder
    ).toContain('full path');
  });

  it('requires a whole-number port in the allowed range', () => {
    expect(
      validateSettings({ photosFolder: 'C:\\Photos', deleteBehavior: 'index_only', port: '80' })
        .port
    ).toContain('1024');
    expect(
      validateSettings({
        photosFolder: 'C:\\Photos',
        deleteBehavior: 'index_only',
        port: '70000',
      }).port
    ).toContain('1024');
    expect(
      validateSettings({
        photosFolder: 'C:\\Photos',
        deleteBehavior: 'index_only',
        port: '8a27',
      }).port
    ).toContain('whole number');
  });

  it('accepts a valid form and maps saved settings into form values', () => {
    const errors = validateSettings({
      photosFolder: 'C:\\Photos',
      deleteBehavior: 'delete_file',
      port: '9000',
    });
    expect(hasSettingsErrors(errors)).toBe(false);

    expect(formFromSettings(defaultSettings)).toEqual({
      photosFolder: 'C:\\Photos',
      deleteBehavior: 'index_only',
      port: '8427',
    });
  });
});
