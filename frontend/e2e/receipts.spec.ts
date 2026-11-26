import AxeBuilder from '@axe-core/playwright';
import type { Browser, Page, TestInfo } from '@playwright/test';
import { expect, test } from './support/test';
import { loggedInAdmin } from './support/accounts';
import { assignRole, logInAs, signUpAndVerify } from './support/signup';

// Goods receipt end to end (specs/007-goods-receipt, contracts/ui.md): the owner records a
// partial receipt (no fully-received warning), then one that completes the line (the
// warning shows); the list badges say how much arrived; the Approver's cancel dialog names
// what was received. Axe on the form, the dialog and each page. The stack's demo data
// provides the vendor (Acme Supplies) and the seeded tier (₹1,00,000). One set of accounts
// for the file (ADR-0017's per-IP limit).

test.describe.configure({ mode: 'serial' });

let buyer: Page;
let approver: Page;
let admin: Page;
const run = String(Date.now());
const ordered = 10;

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
  for (const [name, role] of [
    [`Receipt Buyer ${run}`, 'Buyer'],
    [`Receipt Approver ${run}`, 'Approver'],
  ] as const) {
    const page = await newPage(browser, testInfo);
    const user = await signUpAndVerify(page, name);
    await assignRole(admin, user, role);
    await logInAs(page, user.email, 'Welcome');
    pages.push(page);
  }
  [buyer, approver] = pages as [Page, Page];
});

test.afterAll(async () => {
  await Promise.all([buyer, approver, admin].map((page) => page.context().close()));
});

async function axe(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations.map((v) => `${v.id}: ${v.help}`);
}

const cell = (page: Page, label: string, line: number) =>
  page.getByLabel(`${label}, line ${String(line)}`, { exact: true });

/** A submitted one-line order of `ordered` units; returns its path and PO number. */
async function submittedOrder(unitPrice: string, expected: string) {
  await buyer.goto('/orders/new');
  await buyer.getByRole('combobox', { name: 'Vendor' }).fill('Acme');
  await buyer.getByRole('option', { name: 'Acme Supplies', exact: true }).click();
  await cell(buyer, 'Description', 1).fill('Pallet racking');
  await cell(buyer, 'Quantity', 1).fill(String(ordered));
  await cell(buyer, 'Unit price', 1).fill(unitPrice);
  await buyer.getByRole('button', { name: 'Create order' }).click();
  const heading = buyer.getByRole('heading', { level: 1, name: /^PO-\d{4}-\d{2}-\d{6,}$/ });
  await expect(heading).toBeVisible();
  const poNumber = (await heading.textContent()) ?? '';
  await buyer.getByRole('button', { name: 'Submit', exact: true }).click();
  const dialog = buyer.getByRole('alertdialog', { name: `Submit ${poNumber}?` });
  await expect(dialog.getByText(expected)).toBeVisible();
  await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
  return { path: new URL(buyer.url()).pathname, poNumber };
}

/** Records `quantity` on line 1 through the form and its dialog; returns the dialog's text. */
async function receive(poNumber: string, quantity: number, checkAxe = false) {
  await buyer.getByRole('button', { name: 'Record receipt', exact: true }).click();
  const form = buyer.getByRole('form', { name: 'Record receipt' });
  await form.getByLabel(/^Line 1, Pallet racking: quantity received/).fill(String(quantity));
  if (checkAxe) expect(await axe(buyer), 'receipt form').toEqual([]);
  await form.getByRole('button', { name: 'Continue' }).click();
  const dialog = buyer.getByRole('alertdialog', { name: `Record receipt for ${poNumber}?` });
  await expect(dialog.getByRole('button', { name: 'Record receipt' })).toBeVisible();
  if (checkAxe) expect(await axe(buyer), 'receipt dialog').toEqual([]);
  const text = (await dialog.textContent()) ?? '';
  await dialog.getByRole('button', { name: 'Record receipt' }).click();
  await expect(buyer.getByText('Receipt recorded.', { exact: true })).toBeVisible();
  return text;
}

/** The status cell of `poNumber`'s row in the Buyer's order list. */
async function listStatus(poNumber: string): Promise<string> {
  await buyer.goto('/orders');
  const row = buyer.getByRole('row').filter({ hasText: poNumber });
  await expect(row).toHaveCount(1);
  return (await row.textContent()) ?? '';
}

let full = { path: '', poNumber: '' };
let partly = { path: '', poNumber: '' };

test.describe('[NFR-FE-07] goods receipt end to end', () => {
  test('[FR-RCV-01] an approved order received in part, then in full: the warning only on the receipt that completes the line', async () => {
    full = await submittedOrder('15000', 'Will go to the Approver for approval');
    await expect(buyer.getByText('Submitted. It is waiting for approval.')).toBeVisible();
    await approver.goto(full.path);
    await approver.getByRole('button', { name: 'Approve', exact: true }).click();
    await approver
      .getByRole('alertdialog', { name: `Approve ${full.poNumber}?` })
      .getByRole('button', { name: 'Approve', exact: true })
      .click();
    await expect(approver.getByText('Approved.', { exact: true })).toBeVisible();

    await buyer.goto(full.path);
    const first = await receive(full.poNumber, 4, true);
    expect(first).toContain('receiving 4, received so far 0, outstanding after 6');
    expect(first).not.toContain('as fully received');
    await expect(buyer.getByText('Partly received', { exact: true }).first()).toBeVisible();

    const second = await receive(full.poNumber, 6);
    expect(second).toContain('receiving 6, received so far 4, outstanding after 0');
    expect(second).toContain(
      "This marks line 1 as fully received. Receipts can't be changed or undone.",
    );
    await expect(buyer.getByText('Fully received', { exact: true }).first()).toBeVisible();
    await expect(buyer.getByRole('button', { name: 'Record receipt', exact: true })).toHaveCount(0);
    await expect(buyer.getByRole('region', { name: 'Receipts' })).toContainText('Received on');
    expect(await axe(buyer), 'fully received order').toEqual([]);
  });

  test('[FR-RCV-01] the list badges say how much of each order arrived', async () => {
    partly = await submittedOrder('5000', 'Will be auto-approved');
    await expect(buyer.getByText('Submitted and approved automatically.')).toBeVisible();
    await receive(partly.poNumber, 3);

    expect(await listStatus(full.poNumber)).toContain('Approved · Fully received');
    expect(await listStatus(partly.poNumber)).toContain('Approved · Partly received');
    expect(await axe(buyer), 'order list with badges').toEqual([]);
  });

  test("[FR-LCK-02] the Approver's cancel dialog names what was received; the list then says cancelled, partly received", async () => {
    await approver.goto(partly.path);
    await approver.getByRole('button', { name: 'Cancel order', exact: true }).click();
    const dialog = approver.getByRole('alertdialog', { name: `Cancel ${partly.poNumber}?` });
    await expect(dialog.getByText('1 of 1 line partly received')).toBeVisible();
    await expect(dialog.getByText('Nothing has been received', { exact: false })).toHaveCount(0);
    expect(await axe(approver), 'cancel dialog with receipts').toEqual([]);
    await dialog.getByLabel('Reason').fill('Supplier closed; the rest never came');
    await dialog.getByRole('button', { name: 'Cancel order', exact: true }).click();
    await expect(approver.getByText('Cancelled.', { exact: true })).toBeVisible();

    expect(await listStatus(partly.poNumber)).toContain('Cancelled · partly received');
  });
});
