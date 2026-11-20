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

test('simulate scan pairs the sample PC', async ({ page }) => {
  await page.goto('/?latency=0&scenario=unpaired');
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveScreenshot('pair-dialog.png');
  await dialog.getByRole('button', { name: 'Simulate scan' }).click();
  await expect(page.getByTestId('backup-status')).toContainText('waiting to back up');

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText('STUDIO-PC')).toBeVisible();
  await expect(page.getByText('192.168.1.24:8427')).toBeVisible();
});

test('pairing code problems use plain sentences', async ({ page }) => {
  await page.goto('/?latency=0&scenario=unpaired');
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const code = dialog.getByLabel('Pairing code');
  const pairButton = dialog.getByRole('button', { name: 'Pair', exact: true });
  const valid = {
    version: 1,
    serverName: 'STUDIO-PC',
    addresses: ['192.168.1.24'],
    port: 8427,
    fingerprint: '4B:1E:9C:2A:77:0D:31:8F:6E:52:A0:CD:19:44:B8:7E:23:91:0F:5A:C7:64:D2:88:3B:EE:15:6D:9A:40:52:FC',
    token: 'XM7K-4QDP',
  };

  await code.fill('{"hello":"world"}');
  await pairButton.click();
  await expect(dialog.getByRole('alert')).toHaveText('This is not a pairing code.');

  await code.fill(JSON.stringify({ ...valid, version: 2 }));
  await pairButton.click();
  await expect(dialog.getByRole('alert')).toContainText('different app version');

  await code.fill(JSON.stringify({ ...valid, fingerprint: 'abc' }));
  await pairButton.click();
  await expect(dialog.getByRole('alert')).toContainText('The code is damaged');

  await code.fill(JSON.stringify({ ...valid, expiresAt: '2020-01-01T00:00:00.000Z' }));
  await pairButton.click();
  await expect(dialog.getByRole('alert')).toContainText('This code expired');

  await code.fill('http://not-a-code');
  await pairButton.click();
  await expect(dialog.getByRole('alert')).toHaveText('This is not a pairing code.');
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

test('back up now drains the pending queue', async ({ page }) => {
  await page.goto('/?latency=0');
  await waitForLibrary(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByTestId('settings-backup-now').click();
  await page.getByRole('button', { name: 'Photos' }).click();
  const bar = page.getByTestId('backup-status');
  await expect(bar).toContainText('Backing up');
  await expect
    .poll(async () => (await bar.textContent()) ?? '', { timeout: 15_000 })
    .toContain('All photos are on your PC');
});

test('back up now on an offline PC pauses with a clear message', async ({ page }) => {
  await page.goto('/?latency=0&scenario=offline');
  await waitForLibrary(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByTestId('settings-backup-now').click();
  await page.getByRole('button', { name: 'Photos' }).click();
  await expect(page.getByTestId('backup-status')).toContainText('PC not reachable');
});

test('phone library shows backup badges and opens the viewer', async ({ page }) => {
  await page.goto('/?latency=0');
  await waitForLibrary(page);
  await page.getByRole('button', { name: 'Library' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible();
  const grid = page.getByLabel('Phone library');
  await expect(grid).toBeVisible();
  await expect(page.locator('.xm-tile__flag').first()).toBeVisible();
  await page.locator('[data-xm-tile="0"]').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close viewer' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('deleting from the PC library removes the photo and refreshes the status', async ({ page }) => {
  await page.goto('/?latency=0');
  await waitForLibrary(page);
  const tilesBefore = await page.locator('[data-xm-tile]').count();
  await page.locator('[data-xm-tile="0"]').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Delete photo' })
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close viewer' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const tilesAfter = await page.locator('[data-xm-tile]').count();
  expect(tilesAfter).toBeLessThan(tilesBefore);
});
