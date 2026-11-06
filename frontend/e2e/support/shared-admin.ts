import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loggedInAdmin } from './accounts';
import { test as base } from './test';

// One logged-in admin per worker, for tests that only look at pages (shell, axe, CSP,
// cookies). Every login from the stack's one address counts toward ADR-0017's per-IP
// login limit (30 a minute), so tests that don't change the session share one instead of
// logging in each time. Tests that log out, refresh or revoke keep logging in on their own.
// Playwright's documented pattern: the storageState option, filled by a worker fixture.

export const test = base.extend<object, { adminStorageState: string }>({
  storageState: ({ adminStorageState }, provide) => provide(adminStorageState),
  adminStorageState: [
    async ({ browser }, provide, workerInfo) => {
      const dir = join(workerInfo.project.outputDir, '.auth');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `admin-${String(workerInfo.parallelIndex)}.json`);
      const { baseURL, ignoreHTTPSErrors } = workerInfo.project.use;
      // A context of its own, with no storage state yet: this is where it is made. It takes
      // the project's base URL and certificate setting, as a test's own context does.
      const page = await browser.newPage({
        ...(baseURL === undefined ? {} : { baseURL }),
        ...(ignoreHTTPSErrors === undefined ? {} : { ignoreHTTPSErrors }),
      });
      await loggedInAdmin(page);
      await page.context().storageState({ path: file });
      await page.context().close();
      await provide(file);
    },
    { scope: 'worker' },
  ],
});

export { expect } from './test';
