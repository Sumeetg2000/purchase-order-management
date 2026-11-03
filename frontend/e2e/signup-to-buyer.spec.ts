import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { E2E_PASSWORD } from './support/accounts';
import { linkEmailedTo } from './support/mailpit';

// Spec US2's independent test (SC-001): a new employee signs up, verifies from the email,
// logs in to Access pending and asks for access. US3 continues it to a Buyer.

test.describe('[FR-ACC-01] signup to Access pending', () => {
  test('[FR-ACC-01] sign up, verify from the email, log in, and ask for access', async ({
    page,
  }) => {
    const email = `e2e-${randomUUID().slice(0, 8)}@example.local`;

    await page.goto('/signup');
    await page.getByLabel('Name').fill('New Employee');
    await page.getByLabel('Work email').fill(email);
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign up' }).click();
    await expect(page.getByRole('status')).toContainText(`We sent a verification link to ${email}`);

    await page.goto(await linkEmailedTo(email, '/verify-email'));
    await expect(page.getByText('Your email is confirmed.')).toBeVisible();
    await expect(page).toHaveURL(/\/verify-email$/);

    await page.getByRole('link', { name: 'Log in' }).click();
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Access pending' })).toBeVisible();
    await expect(page).toHaveURL(/\/access-pending$/);

    await page.getByLabel('Message the administrator').fill('Please add me as a buyer.');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText(/^Request sent on /)).toBeVisible();
  });
});
