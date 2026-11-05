import { randomUUID } from 'node:crypto';
import { expect, type Browser, type Locator, type Page } from '@playwright/test';
import { E2E_PASSWORD, loggedInAdmin } from './accounts';
import { linkEmailedTo } from './mailpit';

// Self-signup users for end-to-end tests: each signs up, verifies from Mailpit with the
// signup password and logs in to Access pending.

export interface SignedUpUser {
  name: string;
  email: string;
}

export async function signUpAndVerify(page: Page, name: string): Promise<SignedUpUser> {
  const email = `e2e-${randomUUID().slice(0, 8)}@example.local`;
  await page.goto('/signup');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page.getByRole('status')).toContainText(`We sent a verification link to ${email}`);
  await page.goto(await linkEmailedTo(email, '/verify-email'));
  await expect(page.getByText('Enter the password you chose to confirm your email')).toBeVisible();
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Confirm email' }).click();
  await expect(page.getByText('Your email is confirmed.')).toBeVisible();
  return { name, email };
}

/** Logs in from the login page; `landing` is the heading the user should land on. */
export async function logInAs(page: Page, email: string, landing: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: landing })).toBeVisible();
}

export async function askForAccess(page: Page, message: string) {
  await page.getByLabel('Message the administrator').fill(message);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText(/^Request sent on /)).toBeVisible();
}

/** A fresh admin logged in on a page of their own (a second browser context). */
export async function adminPage(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await loggedInAdmin(page);
  return page;
}

/** As the admin, assigns a role set to a user from the Users screen. */
export async function assignRole(admin: Page, user: SignedUpUser, role: string) {
  await admin.goto(`/admin/users?q=${encodeURIComponent(user.email)}`);
  await admin.getByRole('button', { name: `Change role for ${user.name}` }).click();
  const dialog = admin.getByRole('alertdialog');
  await chooseRadio(dialog, role);
  await dialog.getByRole('button', { name: 'Change role' }).click();
  await expect(admin.getByRole('status')).toContainText(`${user.name}'s role is now ${role}.`);
}

/** Selects a radio by keyboard: React Aria keeps the input visually hidden. */
export async function chooseRadio(scope: Locator, name: string) {
  const radio = scope.getByRole('radio', { name, exact: true });
  await radio.press('Space');
  await expect(radio).toBeChecked();
}
