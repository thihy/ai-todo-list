// E2E test stub. Runs the actual packaged app via Playwright's electron driver.
// Marks this as a placeholder — full scenarios are described in tests/e2e/README.md.

import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';

test.skip('app boots and shows the sidebar (placeholder)', async () => {
  const app = await electron.launch({ args: ['.'] });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await expect(window.locator('nav[aria-label="Primary"]')).toBeVisible();
  await app.close();
});
