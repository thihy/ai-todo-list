import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'app://thihy-todolist',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'electron', use: { ...devices['Desktop Chrome'] } }],
});