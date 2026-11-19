import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function waitForLibrary(page: Page) {
  await expect(page.getByRole('heading', { level: 1, name: 'Photos' })).toBeVisible();
  await expect(page.locator('[data-xm-tile="0"]')).toBeVisible();
  await page
    .locator('[data-xm-tile="0"] img')
    .evaluate(async (image) => (image as HTMLImageElement).decode());
  await page.waitForTimeout(150);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/?latency=0');
  await waitForLibrary(page);
});

test('photos timeline and backup status', async ({ page }) => {
  await expect(page.getByTestId('backup-status')).toContainText('waiting to back up');
  await expect(page).toHaveScreenshot('photos.png');
});

test('library placeholder', async ({ page }) => {
  await page.getByRole('button', { name: 'Library' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible();
  await page.getByRole('region', { name: 'Photo timeline' }).waitFor({ state: 'detached' });
  await expect(page).toHaveScreenshot('library.png');
});

test('settings with backup rules', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Wi-Fi only' })).toBeChecked();
  await expect(page).toHaveScreenshot('settings.png');
});

test('full-screen viewer', async ({ page }) => {
  await page.locator('[data-xm-tile="0"]').click();
  const viewer = page.getByRole('dialog');
  await expect(viewer).toBeVisible();
  await expect(page).toHaveScreenshot('viewer.png');
});

test('dark mode follows the OS', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
  await expect(page).toHaveScreenshot('photos-dark.png');
});

test('PC not reachable status', async ({ page }) => {
  await page.goto('/?latency=0&scenario=offline');
  await expect(page.getByTestId('backup-status')).toContainText('PC not reachable');
  await expect(page.getByTestId('backup-status')).toContainText(
    "Will back up when you're home"
  );
});

test('unpaired status offers pairing', async ({ page }) => {
  await page.goto('/?latency=0&scenario=unpaired');
  await expect(page.getByTestId('backup-status')).toContainText('Back up to your PC');
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('mock pairing and setting changes take effect', async ({ page }) => {
  await page.goto('/?latency=0&scenario=unpaired');
  await page.getByRole('button', { name: 'Pair' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByTestId('backup-status')).toContainText('waiting to back up');

  await page.getByRole('button', { name: 'Settings' }).click();
  const wifiOnly = page.getByRole('switch', { name: 'Wi-Fi only' });
  await expect(wifiOnly).toBeChecked();
  await wifiOnly.click();
  await expect(wifiOnly).not.toBeChecked();
});
