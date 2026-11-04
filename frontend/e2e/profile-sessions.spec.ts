import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { E2E_PASSWORD, logIn, loggedInAdmin } from './support/accounts';

// Spec US4's independent test (FR-036): edit the name, change the password from one
// browser and see the other logged out with the reason, revoke another session.

const NEW_PASSWORD = 'another e2e passphrase';

/** The same user logged in from a second browser. */
async function secondBrowser(browser: Browser, email: string, password = E2E_PASSWORD) {
  const page = await (await browser.newContext()).newPage();
  await logIn(page, email, password);
  return page;
}

function otherSessionRow(page: Page) {
  return page
    .getByRole('table', { name: 'Sessions' })
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: /^Revoke / }) })
    .filter({ hasNotText: 'This device' });
}

test.describe('[FR-ACC-06] profile and sessions', () => {
  test('[FR-USR-01] the name saves with no dialog and shows in the header', async ({ page }) => {
    await loggedInAdmin(page);
    await page.goto('/profile');
    const name = page.getByLabel('Name');
    await name.fill('Renamed E2E Admin');
    await page.getByRole('button', { name: 'Save name' }).click();
    await expect(page.getByRole('status')).toContainText('Your name is saved.');
    await expect(page.getByRole('banner')).toContainText('Renamed E2E Admin');
    await page.reload();
    await expect(page.getByLabel('Name')).toHaveValue('Renamed E2E Admin');
  });

  test('[FR-ACC-06] a revoked session is sent to login: "You\'ve been logged out."', async ({
    page,
    browser,
  }) => {
    const admin = await loggedInAdmin(page);
    const other = await secondBrowser(browser, admin.email);
    await page.goto('/profile');
    await otherSessionRow(page)
      .getByRole('button', { name: /^Revoke / })
      .click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke session' }).click();
    await expect(page.getByRole('status')).toContainText('Session revoked.');
    await expect(otherSessionRow(page)).toHaveCount(0);

    await other.reload();
    await expect(other.getByRole('heading', { level: 1, name: 'Log in' })).toBeVisible();
    await expect(other.getByRole('status')).toContainText(
      "You've been logged out. Please log in again.",
    );
  });

  test('[FR-ACC-04] a password change logs the other browser out with the reason', async ({
    page,
    browser,
  }) => {
    const admin = await loggedInAdmin(page);
    const other = await secondBrowser(browser, admin.email);
    await page.goto('/profile');
    await page.getByLabel('Current password').fill(E2E_PASSWORD);
    await page.getByLabel('New password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Change password' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Change your password?' });
    await dialog.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByRole('status')).toContainText('Your password is changed.');

    await other.reload();
    await expect(other.getByRole('status')).toContainText(
      'You were logged out because your password was changed. Please log in again.',
    );
    await logIn(other, admin.email, NEW_PASSWORD);
    // This browser kept its session.
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
  });

  test('[NFR-SEC-03] log out everywhere ends this browser and the other one', async ({
    page,
    browser,
  }) => {
    const admin = await loggedInAdmin(page);
    const other = await secondBrowser(browser, admin.email);
    await page.goto('/profile');
    await page.getByRole('button', { name: 'Log out everywhere' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Log out everywhere?' });
    await dialog.getByRole('button', { name: 'Log out everywhere' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Log in' })).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    await other.reload();
    await expect(other.getByRole('status')).toContainText(
      "You've been logged out. Please log in again.",
    );
  });

  test('[NFR-FE-05] /profile has no axe or CSP violations', async ({ page }) => {
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { cspViolations: string[] }).cspViolations = seen;
      document.addEventListener('securitypolicyviolation', (event) => {
        seen.push(`${event.violatedDirective} blocked ${event.blockedURI}`);
      });
    });
    await loggedInAdmin(page);
    await page.goto('/profile');
    await expect(page.getByRole('table', { name: 'Sessions' })).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    expect(
      await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations),
    ).toEqual([]);
  });
});
