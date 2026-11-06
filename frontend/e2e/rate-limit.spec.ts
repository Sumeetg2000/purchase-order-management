import { randomUUID } from 'node:crypto';
import { expect, test } from './support/test';

// The rate limits stay on in the end-to-end stack. Only the per-address counters are
// cleared before each spec file (support/limits.ts); this test drives the per-email
// forgot-password bucket for a fresh address, which nothing else touches or clears.

const FORGOT_EMAIL_LIMIT = 3;

test('[NFR-SEC-08] forgot-password past its per-email limit is refused with the rate-limit message', async ({
  page,
}) => {
  const email = `e2e-limit-${randomUUID().slice(0, 8)}@example.local`;
  await page.goto('/forgot-password');
  const alert = page.getByRole('alert');
  for (let attempt = 1; attempt <= FORGOT_EMAIL_LIMIT; attempt++) {
    await page.getByLabel('Email').fill(email);
    const answered = page.waitForResponse('**/api/auth/forgot-password');
    await page.getByRole('button', { name: 'Send reset link' }).click();
    expect((await answered).status()).toBe(404);
    await expect(alert).toContainText('No account found with this email.');
  }
  const refused = page.waitForResponse('**/api/auth/forgot-password');
  await page.getByRole('button', { name: 'Send reset link' }).click();
  const response = await refused;
  expect(response.status()).toBe(429);
  expect(await response.json()).toMatchObject({ code: 'RATE_LIMITED' });
  await expect(alert).toContainText('Too many attempts.');
});
