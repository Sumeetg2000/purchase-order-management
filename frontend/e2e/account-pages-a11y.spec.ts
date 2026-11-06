import AxeBuilder from '@axe-core/playwright';
import { test as anonymousTest, type Page } from '@playwright/test';
import { linkEmailedTo } from './support/mailpit';
import { expect, test } from './support/shared-admin';
import { E2E_PASSWORD } from './support/accounts';
import { logInAs } from './support/signup';

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

anonymousTest.describe(
  '[NFR-FE-05] slice 1 self-service pages: accessibility and content security',
  () => {
    anonymousTest(
      '[NFR-FE-05] /signup, /verify-email and /access-pending have no axe or CSP violations',
      async ({ page }) => {
        const violations = await cspViolations(page);
        const email = `e2e-${String(Date.now())}@example.local`;
        await page.goto('/signup');
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        expect(await axe(page), '/signup').toEqual([]);

        await page.getByLabel('Name').fill('Axe Check');
        await page.getByLabel('Work email').fill(email);
        await page.getByLabel('Password').fill(E2E_PASSWORD);
        await page.getByRole('button', { name: 'Sign up' }).click();
        await expect(page.getByRole('status')).toContainText('We sent a verification link');
        expect(await axe(page), '/signup sent').toEqual([]);

        await page.goto(await linkEmailedTo(email, '/verify-email'));
        await expect(page.getByLabel('Password')).toBeVisible();
        expect(await axe(page), '/verify-email').toEqual([]);
        await page.getByLabel('Password').fill(E2E_PASSWORD);
        await page.getByRole('button', { name: 'Confirm email' }).click();
        await expect(page.getByText('Your email is confirmed.')).toBeVisible();

        await logInAs(page, email, 'Access pending');
        expect(await axe(page), '/access-pending').toEqual([]);
        expect(await violations()).toEqual([]);
      },
    );
  },
);

async function axe(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations.map((v) => `${v.id}: ${v.help}`);
}

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
