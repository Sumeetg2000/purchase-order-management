import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { defineConfig, devices } from '@playwright/test';

// End-to-end tests against the running compose stack (research R19). Chromium on every
// pull request; E2E_BROWSERS=chromium,firefox,webkit on main and nightly (research R22).
const ENGINES = {
  chromium: devices['Desktop Chrome'],
  firefox: devices['Desktop Firefox'],
  webkit: devices['Desktop Safari'],
} as const;

type Engine = keyof typeof ENGINES;
const engines = (process.env['E2E_BROWSERS'] ?? 'chromium').split(',') as Engine[];
for (const engine of engines) {
  if (!(engine in ENGINES)) throw new Error(`E2E_BROWSERS: unknown engine "${engine}"`);
}

/**
 * The stack's own origin (APP_ORIGIN in its env file), so the browser's Origin header is
 * the one the API accepts: the API refuses state changes from any other origin.
 */
function appOrigin(): string | undefined {
  const file = process.env['E2E_ENV_FILE'] ?? fileURLToPath(new URL('../.env', import.meta.url));
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8'))['APP_ORIGIN'] : undefined;
}

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  reporter: [
    ['list'],
    ['json', { outputFile: fileURLToPath(new URL('../reports/playwright.json', import.meta.url)) }],
  ],
  use: { baseURL: process.env['E2E_BASE_URL'] ?? appOrigin() ?? 'http://localhost:8080' },
  projects: engines.map((name) => ({ name, use: ENGINES[name] })),
});
