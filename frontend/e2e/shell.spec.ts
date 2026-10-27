import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { SECURITY_HEADERS } from '../../deploy/security-headers.mjs';

// The production shell, served by nginx from the compose stack.

const SHELL_PAGES = ['/', '/no/such/page'];

test.describe('[NFR-FE-07] app shell', () => {
  test('[NFR-FE-07] the home page renders in the shell, and navigation reaches not-found and back', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Welcome' })).toBeVisible();
    await page.goto('/no/such/page');
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await page.getByRole('link', { name: 'Go to the home page' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Welcome' })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
  });

  test('[NFR-FE-07] the development demo route is not in the production build', async ({
    page,
  }) => {
    await page.goto('/__demo');
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  });
});

test.describe('[NFR-FE-05] accessibility and content security', () => {
  for (const path of SHELL_PAGES) {
    test(`[NFR-FE-05] ${path} has no axe violations (WCAG 2.1 AA)`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    });
  }

  test('[NFR-FE-05] pages and assets carry the exact production CSP and security headers', async ({
    request,
  }) => {
    const html = await request.get('/');
    const asset = /<script[^>]+src="([^"]+)"/.exec(await html.text())?.[1];
    expect(asset, 'the page loads a script file').toBeDefined();
    for (const response of [html, await request.get(asset ?? '')]) {
      expect(response.status()).toBe(200);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        expect(response.headers()[name.toLowerCase()], name).toBe(value);
      }
    }
  });

  test('[NFR-FE-05] the HTML has no inline script and runs with no CSP violation', async ({
    page,
  }) => {
    const violations: string[] = [];
    page.on('console', (message) => {
      if (/Content Security Policy|Content-Security-Policy/i.test(message.text())) {
        violations.push(message.text());
      }
    });
    const response = await page.goto('/');
    const body = (await response?.text()) ?? '';
    const scripts = [...body.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.filter((tag) => !/\bsrc=/.test(tag))).toEqual([]);
    await expect(page.getByRole('heading', { level: 1, name: 'Welcome' })).toBeVisible();
    expect(violations).toEqual([]);
  });
});
