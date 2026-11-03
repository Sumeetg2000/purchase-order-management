import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { expect, type BrowserContext, type Page } from '@playwright/test';

// Accounts for end-to-end tests against the compose stack. Each test gets its own admin
// from admin:create (the operator CLI), so no test depends on another or on the
// single-use bootstrap link.

const ROOT = new URL('../../../', import.meta.url);
export const E2E_PASSWORD = 'an e2e test passphrase';

export interface NewAdmin {
  email: string;
  /** The set-password page with its token, as a path on the app (the origin may differ). */
  setPasswordPath: string;
}

/** Creates an admin with the operator CLI and returns their one-time link. */
export function createAdmin(): NewAdmin {
  const email = `e2e-${randomUUID().slice(0, 8)}@example.local`;
  const output = execFileSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'api',
      'npm',
      'run',
      '-s',
      'admin',
      '--',
      'admin:create',
      '--email',
      email,
      '--name',
      'E2E Admin',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const link = /https?:\/\/\S+\/reset-password#token=[A-Za-z0-9_-]+/.exec(output)?.[0];
  if (!link) throw new Error(`admin:create printed no set-password link:\n${output}`);
  const url = new URL(link);
  return { email, setPasswordPath: `${url.pathname}${url.hash}` };
}

export async function setPassword(page: Page, admin: NewAdmin, password = E2E_PASSWORD) {
  await page.goto(admin.setPasswordPath);
  await page.getByLabel('New password').fill(password);
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(page.getByRole('status')).toContainText('Your password is set.');
}

export async function logIn(page: Page, email: string, password = E2E_PASSWORD) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome' })).toBeVisible();
}

/** A fresh admin, logged in. */
export async function loggedInAdmin(page: Page): Promise<NewAdmin> {
  const admin = createAdmin();
  await setPassword(page, admin);
  await logIn(page, admin.email);
  return admin;
}

/**
 * Replaces the access cookie with the same token already expired, as if 15 minutes had
 * passed, by re-signing it with the stack's key from .env (HS256, ADR-0017).
 */
export async function expireAccessToken(context: BrowserContext): Promise<void> {
  // The stack's env file: .env, or E2E_ENV_FILE when the stack was started with another.
  const file = process.env['E2E_ENV_FILE'] ?? new URL('.env', ROOT);
  const env = parseEnv(readFileSync(file, 'utf8'));
  const key = Buffer.from(env['JWT_SIGNING_KEY'] ?? '', 'base64url');
  const cookie = (await context.cookies()).find((c) => c.name === 'po_access');
  if (!cookie) throw new Error('no access cookie to expire');
  const [header = '', payload = ''] = cookie.value.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
    string,
    number
  >;
  const now = Math.floor(Date.now() / 1_000);
  const expired = Buffer.from(
    JSON.stringify({ ...claims, iat: now - 960, exp: now - 60 }),
  ).toString('base64url');
  const signature = createHmac('sha256', key).update(`${header}.${expired}`).digest('base64url');
  await context.addCookies([{ ...cookie, value: `${header}.${expired}.${signature}` }]);
}
