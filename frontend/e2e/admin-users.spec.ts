import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { E2E_PASSWORD } from './support/accounts';
import { adminPage, assignRole, logInAs, signUpAndVerify } from './support/signup';

// An admin changes a user's role (that user is sent to login, and the new role applies)
// and deactivates a user (FR-036; spec US3's independent test).

test.describe('[FR-ADM-02] admin user actions', () => {
  test('[FR-ADM-02] a role change sends the user to login; deactivation refuses their login', async ({
    page,
    browser,
  }) => {
    const user = await signUpAndVerify(page, `Role Change ${String(Date.now())}`);
    const admin = await adminPage(browser);
    await assignRole(admin, user, 'Buyer');
    await logInAs(page, user.email, 'Welcome');

    await assignRole(admin, user, 'Approver');
    await page.reload();
    await expect(page.getByRole('status')).toContainText(
      'You were logged out because your roles were changed.',
    );
    await logInAs(page, user.email, 'Welcome');

    await admin.getByRole('button', { name: `Deactivate ${user.name}` }).click();
    const dialog = admin.getByRole('alertdialog', { name: `Deactivate ${user.name}?` });
    await expect(
      dialog.getByText("They'll be logged out everywhere and can't log in."),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Deactivate user' }).click();
    await expect(admin.getByRole('status')).toContainText(`${user.name} is deactivated.`);

    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Log in' })).toBeVisible();
    await page.getByLabel('Email').fill(user.email);
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByRole('alert')).toContainText('This account has been deactivated.');
  });

  for (const path of ['/admin/users', '/admin/users/access-requests']) {
    test(`[NFR-FE-05] ${path} has no axe or CSP violations`, async ({ browser }) => {
      const admin = await adminPage(browser);
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
