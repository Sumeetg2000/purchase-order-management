import { expect, test } from '@playwright/test';
import { loggedInAdmin } from './support/accounts';

// Logout (ADR-0017 "Logout and revocation"; spec US1 scenario 9).

test.describe('[NFR-SEC-03] logout', () => {
  test('[NFR-SEC-03] logging out ends the session: the app goes to login and stays there', async ({
    page,
    context,
  }) => {
    await loggedInAdmin(page);
    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Log in' })).toBeVisible();
    const left = (await context.cookies()).map((c) => c.name);
    expect(left).not.toContain('po_access');
    expect(left).not.toContain('po_refresh');
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Log in' })).toBeVisible();
  });
});
