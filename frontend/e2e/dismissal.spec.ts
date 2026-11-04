import { expect, test } from '@playwright/test';
import { adminPage, askForAccess, logInAs, signUpAndVerify } from './support/signup';

// An admin dismisses an access request with a note, and the user reads it (FR-036).

test('[FR-ADM-06] a dismissed request shows the admin note to the user, who can ask again', async ({
  page,
  browser,
}) => {
  const user = await signUpAndVerify(page, `Waiting User ${String(Date.now())}`);
  await logInAs(page, user.email, 'Access pending');
  await askForAccess(page, 'I joined the buying team.');

  const admin = await adminPage(browser);
  await admin.goto('/admin/users/access-requests?status=OPEN');
  await admin.getByRole('button', { name: `Dismiss request from ${user.name}` }).click();
  const dialog = admin.getByRole('alertdialog', { name: `Dismiss the request from ${user.name}?` });
  await dialog.getByLabel(`Note for ${user.name} (optional)`).fill('Ask your manager to confirm.');
  await dialog.getByRole('button', { name: 'Dismiss request' }).click();
  await expect(admin.getByRole('status')).toContainText(`Request from ${user.name} dismissed.`);

  await page.reload();
  await expect(page.getByText('Your request was dismissed.')).toBeVisible();
  await expect(page.getByText('Ask your manager to confirm.')).toBeVisible();
  await askForAccess(page, 'My manager has confirmed.');
});
