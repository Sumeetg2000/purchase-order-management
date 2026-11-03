import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import {
  createAdmin,
  expireAccessToken,
  logIn,
  loggedInAdmin,
  setPassword,
} from './support/accounts';

// Spec US1's independent test: set a password from the link, log in, survive access-token
// expiry with a silent refresh (ADR-0017, ADR-0018).

test.describe('[FR-ADM-04] set-password link', () => {
  test('[FR-ADM-04] a new admin sets a password from their link, and the token leaves the address bar', async ({
    page,
  }) => {
    const admin = createAdmin();
    await page.goto(admin.setPasswordPath);
    await expect(page.getByRole('heading', { level: 1, name: 'Set a new password' })).toBeVisible();
    await expect(page).toHaveURL(/\/reset-password$/);
    await page.goto('/login');
    await setPassword(page, admin);
    await logIn(page, admin.email);
  });

  test('[FR-ACC-03] a link used twice says so', async ({ page }) => {
    const admin = createAdmin();
    await setPassword(page, admin);
    // A fresh page load: going to the same URL from the same page only changes the hash.
    await page.goto('/login');
    await page.goto(admin.setPasswordPath);
    await page.getByLabel('New password').fill('another e2e passphrase');
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(page.getByRole('alert')).toContainText('This link has already been used.');
  });
});

test.describe('[NFR-FE-02] silent refresh', () => {
  test('[NFR-FE-02] after the access token expires, the next page load refreshes silently', async ({
    page,
    context,
  }) => {
    await loggedInAdmin(page);
    await expireAccessToken(context);
    const refreshed = page.waitForResponse((r) => r.url().endsWith('/api/auth/refresh'));
    await page.reload();
    expect((await refreshed).status()).toBe(204);
    await expect(page.getByRole('heading', { level: 1, name: 'Welcome' })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
  });

  test('[NFR-SEC-01] no auth token is readable by the page', async ({ page }) => {
    await loggedInAdmin(page);
    const readable = await page.evaluate(() => document.cookie);
    expect(readable).toMatch(/po_csrf=/);
    expect(readable).not.toMatch(/po_access|po_refresh/);
  });
});

test.describe('[NFR-FE-05] account pages accessibility and content security', () => {
  for (const path of ['/login', '/reset-password']) {
    test(`[NFR-FE-05] ${path} has no axe or CSP violations`, async ({ page }) => {
      await page.addInitScript(() => {
        const seen: string[] = [];
        (window as unknown as { cspViolations: string[] }).cspViolations = seen;
        document.addEventListener('securitypolicyviolation', (event) => {
          seen.push(`${event.violatedDirective} blocked ${event.blockedURI}`);
        });
      });
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
      const csp = await page.evaluate(
        () => (window as unknown as { cspViolations: string[] }).cspViolations,
      );
      expect(csp).toEqual([]);
    });
  }
});
