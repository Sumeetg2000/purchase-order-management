import { expect, test } from '@playwright/test';
import { adminPage, askForAccess, chooseRadio, logInAs, signUpAndVerify } from './support/signup';

// Spec US2's and US3's independent tests (SC-001, SC-002): a new employee signs up,
// verifies from the email, logs in to Access pending and asks for access; an admin assigns
// Buyer from the request; the employee is sent to login and lands on the Buyer home.

test.describe('[FR-ACC-01] signup to Buyer', () => {
  test('[FR-ACC-01] sign up, verify, ask for access, get Buyer from the request, log in again', async ({
    page,
    browser,
  }) => {
    const user = await signUpAndVerify(page, `New Employee ${String(Date.now())}`);
    await expect(page).toHaveURL(/\/verify-email$/);
    await logInAs(page, user.email, 'Access pending');
    await expect(page).toHaveURL(/\/access-pending$/);
    await askForAccess(page, 'Please add me as a buyer.');

    const admin = await adminPage(browser);
    await admin.goto('/admin/users/access-requests?status=OPEN');
    await expect(
      admin.getByRole('cell', { name: 'Please add me as a buyer.' }).first(),
    ).toBeVisible();
    await admin.getByRole('button', { name: `Assign role to ${user.name}` }).click();
    const dialog = admin.getByRole('alertdialog', { name: `Change role for ${user.name}?` });
    await expect(dialog.getByText('This also resolves their access request.')).toBeVisible();
    await chooseRadio(dialog, 'Buyer');
    await dialog.getByRole('button', { name: 'Change role' }).click();
    await expect(admin.getByRole('status')).toContainText(`${user.name}'s role is now Buyer.`);

    // The employee's session ended with the role change: their next request says why.
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Log in' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText(
      'You were logged out because your roles were changed.',
    );
    await logInAs(page, user.email, 'Welcome');
    await expect(page).toHaveURL(/\/$/);
  });
});
