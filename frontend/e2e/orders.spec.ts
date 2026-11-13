import AxeBuilder from '@axe-core/playwright';
import type { Browser, Page, TestInfo } from '@playwright/test';
import { expect, test } from './support/test';
import { loggedInAdmin } from './support/accounts';
import { assignRole, logInAs, signUpAndVerify } from './support/signup';

// Draft orders end to end (spec FR-025, ui.md): a Buyer raises a multi-line order and sees
// its exact total; an Admin reads it and can't change it; another Buyer can't find it; the
// owner edits it (change, add, remove); two tabs conflict and the second reloads; the owner
// deletes it through its dialog. Axe on every screen. The stack's demo data provides the
// vendor (Acme Supplies). One set of accounts for the file (ADR-0017's per-IP login limit).

test.describe.configure({ mode: 'serial' });

let buyerA: Page;
let buyerB: Page;
let admin: Page;
let orderPath = '';
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
  const pages: Page[] = [];
  for (const name of [`Order Buyer A ${run}`, `Order Buyer B ${run}`]) {
    const page = await newPage(browser, testInfo);
    const user = await signUpAndVerify(page, name);
    await assignRole(admin, user, 'Buyer');
    await logInAs(page, user.email, 'Welcome');
    pages.push(page);
  }
  [buyerA, buyerB] = pages as [Page, Page];
});

test.afterAll(async () => {
  await Promise.all([buyerA, buyerB, admin].map((page) => page.context().close()));
});

async function axe(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations.map((v) => `${v.id}: ${v.help}`);
}

const cell = (page: Page, label: string, line: number) =>
  page.getByLabel(`${label}, line ${String(line)}`, { exact: true });

async function fillLine(page: Page, line: number, values: [string, string, string]) {
  await cell(page, 'Description', line).fill(values[0]);
  await cell(page, 'Quantity', line).fill(values[1]);
  await cell(page, 'Unit price', line).fill(values[2]);
}

test.describe('[FR-PO-01] draft orders end to end', () => {
  test('[FR-PO-07] a Buyer raises a multi-line order and sees its exact total', async () => {
    await buyerA
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Orders' })
      .click();
    await buyerA.getByRole('link', { name: 'New order' }).click();
    await expect(buyerA.getByRole('heading', { level: 1, name: 'New order' })).toBeVisible();
    await buyerA.getByRole('combobox', { name: 'Vendor' }).fill('Acme');
    await buyerA.getByRole('option', { name: 'Acme Supplies' }).click();
    await fillLine(buyerA, 1, ['Washers', '1', '0.1']);
    for (const line of [2, 3]) {
      await buyerA.getByRole('button', { name: 'Add line' }).click();
      await fillLine(buyerA, line, ['Washers', '1', '0.1']);
    }
    await expect(buyerA.getByTestId('order-total')).toHaveText('₹0.30');
    expect(await axe(buyerA), 'editor').toEqual([]);
    await buyerA.getByRole('button', { name: 'Create order' }).click();
    const heading = buyerA.getByRole('heading', { level: 1, name: /^PO-\d{4}-\d{2}-\d{6,}$/ });
    await expect(heading).toBeVisible();
    poNumber = (await heading.textContent()) ?? '';
    orderPath = new URL(buyerA.url()).pathname;
    await expect(buyerA.getByTestId('order-total')).toHaveText('₹0.30');
    expect(await axe(buyerA), 'detail').toEqual([]);
  });

  test('[FR-OWN-01] an Admin reads it with no way to change it; another Buyer cannot find it', async () => {
    await admin.goto(orderPath);
    await expect(admin.getByRole('heading', { level: 1, name: poNumber })).toBeVisible();
    await expect(admin.getByRole('link', { name: 'Edit' })).toHaveCount(0);
    await expect(admin.getByRole('button', { name: 'Delete draft' })).toHaveCount(0);
    await buyerB.goto(orderPath);
    await expect(buyerB.getByText("We couldn't find what you were looking for.")).toBeVisible();
  });

  test('[FR-PO-06] the owner edits it: a line changed, one added, one removed', async () => {
    await buyerA.goto(orderPath);
    await buyerA.getByRole('link', { name: 'Edit' }).click();
    await expect(cell(buyerA, 'Description', 1)).toHaveValue('Washers');
    await cell(buyerA, 'Quantity', 1).fill('10');
    await buyerA.getByRole('button', { name: 'Remove line 3' }).click();
    await buyerA.getByRole('button', { name: 'Add line' }).click();
    await fillLine(buyerA, 3, ['Spacers', '4', '0.25']);
    await expect(buyerA.getByTestId('order-total')).toHaveText('₹2.10');
    await buyerA.getByRole('button', { name: 'Save changes' }).click();
    await expect(buyerA.getByRole('heading', { level: 1, name: poNumber })).toBeVisible();
    await expect(buyerA.getByTestId('order-total')).toHaveText('₹2.10');
  });

  test('[NFR-FE-01] two tabs: the second save is refused and Reload order starts from the stored order', async () => {
    const second = await buyerA.context().newPage();
    await buyerA.goto(`${orderPath}/edit`);
    await second.goto(`${orderPath}/edit`);
    await cell(buyerA, 'Description', 1).fill('Hex washers');
    await buyerA.getByRole('button', { name: 'Save changes' }).click();
    await expect(buyerA.getByRole('heading', { level: 1, name: poNumber })).toBeVisible();
    await cell(second, 'Description', 2).fill('Round washers');
    await second.getByRole('button', { name: 'Save changes' }).click();
    await expect(second.getByText('This order changed since you opened it.')).toBeVisible();
    await second.getByRole('button', { name: 'Reload order' }).click();
    await second.getByRole('button', { name: 'Discard changes' }).click();
    await expect(cell(second, 'Description', 1)).toHaveValue('Hex washers');
    await second.close();
  });

  test('[NFR-FE-09] the owner deletes it through its dialog; it is gone', async () => {
    await buyerA.goto(orderPath);
    await buyerA.getByRole('button', { name: 'Delete draft' }).click();
    const dialog = buyerA.getByRole('alertdialog', { name: `Delete draft ${poNumber}?` });
    await expect(dialog.getByText('This permanently deletes the draft.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Keep draft' })).toBeFocused();
    expect(await axe(buyerA), 'delete dialog').toEqual([]);
    await dialog.getByLabel('Reason (optional)').fill('Raised twice');
    await dialog.getByRole('button', { name: 'Delete draft' }).click();
    await expect(buyerA.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
    await buyerA.goto(orderPath);
    await expect(buyerA.getByText("We couldn't find what you were looking for.")).toBeVisible();
  });
});
