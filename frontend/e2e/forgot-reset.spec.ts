import { expect, test } from './support/test';
import { logIn, loggedInAdmin } from './support/accounts';
import { linkEmailedTo } from './support/mailpit';

// Spec US5's independent test (FR-036): ask for a reset from the login page, open the
// email in Mailpit, set a new password, and see the old session logged out with the reason.

const NEW_PASSWORD = 'a reset e2e passphrase';

test.describe('[FR-ACC-05] forgot and reset a password', () => {
  test('[FR-ACC-05] forgot-password → reset email → reset → the old session is logged out', async ({
    page,
    browser,
  }) => {
    const admin = await loggedInAdmin(page);

    const visitor = await (await browser.newContext()).newPage();
    await visitor.goto('/login');
    await visitor.getByLabel('Email').fill(admin.email);
    await visitor.getByRole('link', { name: 'Forgot your password?' }).click();
    await expect(visitor.getByLabel('Email')).toHaveValue(admin.email);
    await visitor.getByRole('button', { name: 'Send reset link' }).click();
    await expect(visitor.getByRole('status')).toContainText(
      `We sent a password reset link to ${admin.email}.`,
    );

    await visitor.goto(await linkEmailedTo(admin.email, '/reset-password'));
    await expect(visitor).toHaveURL(/\/reset-password$/);
    await visitor.getByLabel('New password').fill(NEW_PASSWORD);
    await visitor.getByRole('button', { name: 'Set password' }).click();
    await expect(visitor.getByRole('status')).toContainText('Your password is set.');
    await logIn(visitor, admin.email, NEW_PASSWORD);

    await page.reload();
    await expect(page.getByRole('status')).toContainText(
      'You were logged out because your password was reset. Please log in again.',
    );
  });
});
