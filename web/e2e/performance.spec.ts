import { expect, test } from '@playwright/test';

/**
 * The desktop gallery uses the shared virtualized grid. This test walks a
 * 5,200-item mock library to the end and records how long it takes while
 * checking that only a small window of tiles is ever mounted.
 */
test('5,200-photo gallery scrolls with a bounded DOM', async ({ page }) => {
  const loadedAt = Date.now();
  await page.goto('/?mock=1&count=5200');
  const grid = page.getByRole('region', { name: 'Photo timeline' });
  await expect(grid).toBeVisible();
  await expect(page.locator('[data-xm-tile="0"]')).toBeVisible();
  const loadMs = Date.now() - loadedAt;

  const scrollStarted = Date.now();
  let lastHeight = 0;
  let stable = 0;
  let iterations = 0;
  for (; iterations < 160; iterations += 1) {
    const state = await grid.evaluate((element) => ({
      top: element.scrollTop,
      height: element.scrollHeight,
      client: element.clientHeight,
    }));
    if (state.top + state.client >= state.height - 2 && state.height === lastHeight) {
      stable += 1;
      if (stable >= 4) break;
    } else {
      stable = 0;
    }
    lastHeight = state.height;
    await grid.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.waitForTimeout(120);
    if (Date.now() - scrollStarted > 15_000) break;
  }

  const scrollMs = Date.now() - scrollStarted;
  const mounted = await page.locator('[data-xm-tile]').count();
  const pinned = (await page.locator('.xm-grid__pin').textContent())?.trim() ?? '';
  const lastTile = await page.locator('[data-xm-tile]').last().getAttribute('data-xm-tile');
  console.log(
    JSON.stringify({ loadMs, scrollMs, iterations, mounted, lastTile, pinned })
  );

  expect(mounted).toBeGreaterThan(0);
  expect(mounted).toBeLessThan(300);
  expect(pinned.length).toBeGreaterThan(0);
  expect(scrollMs).toBeLessThan(15_000);
});
