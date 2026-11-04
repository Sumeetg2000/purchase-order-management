import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './support/shared-admin';

// Axe and CSP on the logged-in pages added by slice 1, with the worker's shared admin
// (support/shared-admin.ts): looking at a page doesn't change the session.

test.describe('[NFR-FE-05] slice 1 pages: accessibility and content security', () => {
  for (const path of ['/admin/users', '/admin/users/access-requests']) {
    test(`[NFR-FE-05] ${path} has no axe or CSP violations`, async ({ page: admin }) => {
      const violations = await cspViolations(admin);
      await admin.goto(path);
      await expect(admin.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(
        admin.getByRole('table').or(admin.getByRole('heading', { level: 2 })),
      ).toBeVisible();
      const results = await new AxeBuilder({ page: admin })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
      expect(await violations()).toEqual([]);
    });
  }

  test('[NFR-FE-05] /profile has no axe or CSP violations', async ({ page }) => {
    const violations = await cspViolations(page);
    await page.goto('/profile');
    await expect(page.getByRole('table', { name: 'Sessions' })).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    expect(await violations()).toEqual([]);
  });
});

/** Starts recording CSP violations on the page; returns a reader for them. */
async function cspViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { cspViolations: string[] }).cspViolations = seen;
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push(`${event.violatedDirective} blocked ${event.blockedURI}`);
    });
  });
  return () =>
    page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations);
}
