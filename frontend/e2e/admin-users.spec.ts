import { expect, test } from '@playwright/test';
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
});
