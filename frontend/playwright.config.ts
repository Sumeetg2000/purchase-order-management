import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { defineConfig, devices } from '@playwright/test';

// End-to-end tests against the running compose stack (research R19). Chromium on every
// pull request; E2E_BROWSERS=chromium,firefox,webkit on main and nightly (research R22).
// The stack is reached over HTTPS through its e2e-only TLS edge (deploy/e2e), whose
// certificate is a throwaway self-signed one, so certificate errors are ignored here.
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
  use: {
    baseURL: process.env['E2E_BASE_URL'] ?? appOrigin() ?? 'http://localhost:8080',
    ignoreHTTPSErrors: true,
  },
  // The browsers run one after another, each after its rate-limit counters are cleared
  // (reset-limits.setup.ts): every request comes from the stack's one address, so
  // browsers running together would share ADR-0017's per-IP limits. A failing browser
  // skips the ones after it; the run fails either way.
  projects: engines.flatMap((name, index) => {
    const previous = engines[index - 1];
    return [
      {
        name: `${name}-reset-limits`,
        testMatch: /reset-limits\.setup\.ts/,
        dependencies: previous === undefined ? [] : [previous],
      },
      { name, use: ENGINES[name], dependencies: [`${name}-reset-limits`] },
    ];
  }),
});
