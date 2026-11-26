import AxeBuilder from '@axe-core/playwright';
import type { Browser, Page, TestInfo } from '@playwright/test';
import { expect, test } from './support/test';
import { loggedInAdmin } from './support/accounts';
import { assignRole, logInAs, signUpAndVerify } from './support/signup';

// The outstanding report end to end (specs/008-outstanding-report, contracts/ui.md): a
// Buyer's approved order is outstanding and theirs alone in their report; the Admin finds
// it by age band and vendor, opens its lines, and reaches it from the By vendor view. Axe
// on both views. The stack's demo data provides the vendor (Acme Supplies) and other
// Buyers' outstanding orders. One set of accounts for the file (ADR-0017's per-IP limit).

test.describe.configure({ mode: 'serial' });

let buyer: Page;
let admin: Page;
let poNumber = '';
const run = String(Date.now());

async function newPage(browser: Browser, testInfo: TestInfo): Promise<Page> {
  const { baseURL, ignoreHTTPSErrors } = testInfo.project.use;
  const context = await browser.newContext({
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(ignoreHTTPSErrors === undefined ? {} : { ignoreHTTPSErrors }),
  });
  return context.newPage();
}

test.beforeAll(async ({ browser }, testInfo) => {
  testInfo.setTimeout(120_000);
  admin = await newPage(browser, testInfo);
  await loggedInAdmin(admin);
  buyer = await newPage(browser, testInfo);
  const user = await signUpAndVerify(buyer, `Report Buyer ${run}`);
  await assignRole(admin, user, 'Buyer');
  await logInAs(buyer, user.email, 'Welcome');
});

test.afterAll(async () => {
  await Promise.all([buyer, admin].map((page) => page.context().close()));
});

async function axe(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations.map((v) => `${v.id}: ${v.help}`);
}

const cell = (page: Page, label: string, line: number) =>
  page.getByLabel(`${label}, line ${String(line)}`, { exact: true });

const reportRow = (page: Page) =>
  page
    .getByRole('table', { name: /outstanding order/ })
    .getByRole('row')
    .filter({ hasText: poNumber });

test.describe('[FR-RPT-01] the outstanding report end to end', () => {
  test('[FR-RPT-01] a Buyer sees their approved order as outstanding, and only their own', async () => {
    await buyer.goto('/orders/new');
    await buyer.getByRole('combobox', { name: 'Vendor' }).fill('Acme');
    await buyer.getByRole('option', { name: 'Acme Supplies', exact: true }).click();
    await cell(buyer, 'Description', 1).fill('Report test bolts');
    await cell(buyer, 'Quantity', 1).fill('12');
    await cell(buyer, 'Unit price', 1).fill('100');
    await buyer.getByRole('button', { name: 'Create order' }).click();
    const heading = buyer.getByRole('heading', { level: 1, name: /^PO-\d{4}-\d{2}-\d{6,}$/ });
    poNumber = (await heading.textContent()) ?? '';
    await buyer.getByRole('button', { name: 'Submit', exact: true }).click();
    await buyer
      .getByRole('alertdialog', { name: `Submit ${poNumber}?` })
      .getByRole('button', { name: 'Submit', exact: true })
      .click();
    await expect(buyer.getByText('Submitted and approved automatically.')).toBeVisible();

    await buyer
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Outstanding' })
      .click();
    await expect(
      buyer.getByRole('heading', { level: 1, name: 'Outstanding orders' }),
    ).toBeVisible();
    await expect(buyer.getByText('Your orders')).toBeVisible();
    await expect(buyer.getByText(/^Ages as of .* \(India time\)$/)).toBeVisible();
    await expect(reportRow(buyer)).toContainText('today');
    await expect(buyer.getByRole('table', { name: '1 outstanding order' })).toBeVisible();
    expect(await axe(buyer), 'Orders view').toEqual([]);
  });

  test('[FR-RPT-01] the Admin finds it by age band and vendor, and opens its lines', async () => {
    await admin.goto('/reports/outstanding');
    await admin.getByLabel('Age').selectOption({ label: '0–30 days' });
    await expect(reportRow(admin)).toContainText('0–30 days');
    await reportRow(admin).getByRole('link', { name: 'Acme Supplies' }).click();
    await expect(admin.getByText(/One vendor/)).toBeVisible();
    await expect(reportRow(admin)).toContainText('1 of 1');
    await admin.getByRole('button', { name: `Show lines of ${poNumber}` }).click();
    const lines = admin.getByRole('table', { name: `Lines of ${poNumber}` });
    await expect(lines.getByRole('row').nth(1)).toContainText('Report test bolts');
    await expect(lines.getByRole('row').nth(1)).toContainText('12');
    expect(await axe(admin), 'Orders view, filtered, lines open').toEqual([]);
  });

  test('[FR-RPT-01] the By vendor view leads to the vendor’s outstanding orders', async () => {
    await admin.goto('/reports/outstanding');
    await admin
      .getByRole('navigation', { name: 'Report views' })
      .getByRole('link', { name: 'By vendor' })
      .click();
    const table = admin.getByRole('table', { name: /vendor/ });
    const acme = table.getByRole('row').filter({ hasText: 'Acme Supplies' });
    await expect(acme).toBeVisible();
    expect(await axe(admin), 'By vendor view').toEqual([]);
    await acme.getByRole('link', { name: 'Acme Supplies' }).click();
    await expect(admin.getByText(/One vendor/)).toBeVisible();
    await expect(reportRow(admin)).toBeVisible();
  });
});
