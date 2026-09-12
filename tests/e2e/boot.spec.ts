// E2E test stub. Runs the actual packaged app via Playwright's electron driver.
// Marks this as a placeholder — full scenarios are described in tests/e2e/README.md.

import { test, expect } from '@playwright/test';
import { launchApp } from './helpers';

test.skip('app boots and shows the sidebar (placeholder)', async () => {
  const { app, win } = await launchApp();
  await expect(win.locator('nav[aria-label="Primary"]')).toBeVisible();
  await app.close();
});
