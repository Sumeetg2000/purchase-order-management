import AxeBuilder from '@axe-core/playwright';
import type { Browser, Locator, Page, TestInfo } from '@playwright/test';
import { ORDER_LOCKED_MESSAGES } from '@po/contracts';
import { expect, test } from './support/test';
import { loggedInAdmin } from './support/accounts';
import { assignRole, logInAs, signUpAndVerify } from './support/signup';

// Submission and approval end to end (spec FR-024, ui.md): at or below the threshold an
// order is approved on submit; above it, it waits in the Approver's queue and nav count
// until approved; a rejection reaches a stale editor; withdraw → edit → resubmit routes
// afresh; a Buyer+Approver never sees their own order to approve. Axe on each new screen
// and dialog; the four dialogs checked as ADR-0018 asks (content, safe button focused,
// Escape closes). The stack's demo data provides the vendor (Acme Supplies) and the seeded
// policy (one tier, ₹1,00,000). One set of accounts for the file (ADR-0017's per-IP limit).

test.describe.configure({ mode: 'serial' });

let buyer: Page;
let approver: Page;
let dual: Page;
let admin: Page;
let buyerName = '';
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
  testInfo.setTimeout(150_000);
  admin = await newPage(browser, testInfo);
  await loggedInAdmin(admin);
  const pages: Page[] = [];
  for (const [name, role] of [
    [`Approval Buyer ${run}`, 'Buyer'],
    [`Approval Approver ${run}`, 'Approver'],
    [`Approval Dual ${run}`, 'Buyer + Approver'],
  ] as const) {
    const page = await newPage(browser, testInfo);
    const user = await signUpAndVerify(page, name);
    await assignRole(admin, user, role);
    await logInAs(page, user.email, 'Welcome');
    pages.push(page);
  }
  [buyer, approver, dual] = pages as [Page, Page, Page];
  buyerName = `Approval Buyer ${run}`;
});

test.afterAll(async () => {
  await Promise.all([buyer, approver, dual, admin].map((page) => page.context().close()));
});

async function axe(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations.map((v) => `${v.id}: ${v.help}`);
}

const cell = (page: Page, label: string, line: number) =>
  page.getByLabel(`${label}, line ${String(line)}`, { exact: true });

/** A one-line draft from Acme Supplies at `unitPrice`; returns its path and PO number. */
async function createDraft(page: Page, unitPrice: string) {
  await page.goto('/orders/new');
  await page.getByRole('combobox', { name: 'Vendor' }).fill('Acme');
  await page.getByRole('option', { name: 'Acme Supplies', exact: true }).click();
  await cell(page, 'Description', 1).fill('Pallet racking');
  await cell(page, 'Quantity', 1).fill('1');
  await cell(page, 'Unit price', 1).fill(unitPrice);
  await page.getByRole('button', { name: 'Create order' }).click();
  const heading = page.getByRole('heading', { level: 1, name: /^PO-\d{4}-\d{2}-\d{6,}$/ });
  await expect(heading).toBeVisible();
  return { path: new URL(page.url()).pathname, poNumber: (await heading.textContent()) ?? '' };
}

/** Opens a dialog from `button`, checks the safe button has focus, and that Escape closes it. */
async function checkDialog(page: Page, button: Locator, title: string, safe: string) {
  await button.click();
  const dialog = page.getByRole('alertdialog', { name: title });
  await expect(dialog.getByRole('button', { name: safe })).toBeFocused();
  expect(await axe(page), title).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await button.click();
  return dialog;
}

async function submit(page: Page, poNumber: string, expected: string) {
  const dialog = await checkDialog(
    page,
    page.getByRole('button', { name: 'Submit', exact: true }),
    `Submit ${poNumber}?`,
    'Keep editing',
  );
  await expect(dialog.getByText(expected)).toBeVisible();
  await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
}

/** The caller's queue total from the API, after checking the reloaded nav link shows it. */
async function navCount(page: Page): Promise<number> {
  const res = await page.request.get('/api/approvals?pageSize=1');
  expect(res.ok()).toBe(true);
  const { total } = (await res.json()) as { total: number };
  await page.reload();
  const name =
    total > 0 ? `Approvals, ${String(total)} order${total === 1 ? '' : 's'} waiting` : 'Approvals';
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }),
  ).toBeVisible();
  return total;
}

test.describe('[FR-APR-01] submission and approval end to end', () => {
  test('[FR-APR-01] at or below the threshold the order is approved on submit and Edit is gone', async () => {
    const { poNumber } = await createDraft(buyer, '50000');
    await submit(buyer, poNumber, 'Will be auto-approved');
    await expect(buyer.getByText('Submitted and approved automatically.')).toBeVisible();
    await expect(buyer.getByText('Approved', { exact: true }).first()).toBeVisible();
    await expect(buyer.getByRole('link', { name: 'Edit' })).toHaveCount(0);
    expect(await axe(buyer), 'approved order').toEqual([]);
  });

  test('[FR-APR-01] above it the order waits in the queue and the nav count until approved', async () => {
    const before = await navCount(approver);
    const { path, poNumber } = await createDraft(buyer, '150000');
    await submit(buyer, poNumber, 'Will go to the Approver for approval');
    await expect(buyer.getByText('Submitted. It is waiting for approval.')).toBeVisible();
    expect(await axe(buyer), 'pending order').toEqual([]);

    expect(await navCount(approver)).toBe(before + 1);
    await approver
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: /^Approvals/ })
      .click();
    await expect(approver.getByRole('heading', { level: 1, name: 'Approvals' })).toBeVisible();
    expect(await axe(approver), 'approval queue').toEqual([]);
    await approver.getByRole('link', { name: poNumber, exact: true }).click();
    await expect(approver).toHaveURL(new RegExp(`${path}$`));

    const dialog = await checkDialog(
      approver,
      approver.getByRole('button', { name: 'Approve', exact: true }),
      `Approve ${poNumber}?`,
      'Not now',
    );
    for (const fact of [buyerName, 'Acme Supplies', '₹1,50,000.00']) {
      await expect(dialog.getByText(fact)).toBeVisible();
    }
    const approvals: string[] = [];
    approver.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/approve')) {
        approvals.push(request.url());
      }
    });
    await dialog.getByRole('button', { name: 'Approve', exact: true }).dblclick();
    await expect(approver.getByText('Approved.', { exact: true })).toBeVisible();
    expect(approvals).toHaveLength(1);
    expect(await navCount(approver)).toBe(before);
  });

  test('[FR-SM-03] a rejection reaches an editor opened before it, with the rejected message', async () => {
    const { path, poNumber } = await createDraft(buyer, '150000');
    const stale = await buyer.context().newPage();
    await stale.goto(`${path}/edit`);
    await expect(cell(stale, 'Description', 1)).toHaveValue('Pallet racking');
    await submit(buyer, poNumber, 'Will go to the Approver for approval');
    await expect(buyer.getByText('Submitted. It is waiting for approval.')).toBeVisible();

    await approver.goto(path);
    const dialog = await checkDialog(
      approver,
      approver.getByRole('button', { name: 'Reject', exact: true }),
      `Reject ${poNumber}?`,
      'Not now',
    );
    await dialog.getByRole('button', { name: 'Reject', exact: true }).click();
    await expect(dialog.getByText('Enter a reason.')).toBeVisible();
    await dialog.getByLabel('Reason').fill('Over budget for this quarter');
    await dialog.getByRole('button', { name: 'Reject', exact: true }).click();
    await expect(approver.getByText('Rejected.', { exact: true })).toBeVisible();

    await cell(stale, 'Description', 1).fill('Pallet racking, galvanised');
    await stale.getByRole('button', { name: 'Save changes' }).click();
    await expect(stale.getByText(ORDER_LOCKED_MESSAGES.REJECTED)).toBeVisible();
    await stale.close();
  });

  test('[FR-APR-02] withdraw, edit and resubmit: the new total routes afresh', async () => {
    const { poNumber } = await createDraft(buyer, '150000');
    await submit(buyer, poNumber, 'Will go to the Approver for approval');
    await expect(buyer.getByText('Submitted. It is waiting for approval.')).toBeVisible();
    const dialog = await checkDialog(
      buyer,
      buyer.getByRole('button', { name: 'Withdraw', exact: true }),
      `Withdraw ${poNumber}?`,
      'Keep it pending',
    );
    await dialog.getByLabel('Reason').fill('Splitting it into two orders');
    await dialog.getByRole('button', { name: 'Withdraw', exact: true }).click();
    await expect(buyer.getByText('Withdrawn. It is a draft again.')).toBeVisible();

    await buyer.getByRole('link', { name: 'Edit' }).click();
    await cell(buyer, 'Unit price', 1).fill('75000');
    await buyer.getByRole('button', { name: 'Save changes' }).click();
    await expect(buyer.getByRole('heading', { level: 1, name: poNumber })).toBeVisible();
    await submit(buyer, poNumber, 'Will be auto-approved');
    await expect(buyer.getByText('Submitted and approved automatically.')).toBeVisible();
  });

  test("[FR-SOD-01] a Buyer+Approver's own order is not in their queue, and they can't approve it", async () => {
    const { path, poNumber } = await createDraft(dual, '150000');
    await submit(dual, poNumber, 'Will go to the Approver for approval');
    await expect(dual.getByText('Submitted. It is waiting for approval.')).toBeVisible();
    await expect(dual.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    await expect(dual.getByRole('button', { name: 'Reject', exact: true })).toHaveCount(0);
    await expect(dual.getByRole('button', { name: 'Withdraw', exact: true })).toBeVisible();

    await dual.goto('/approvals');
    await expect(dual.getByRole('heading', { level: 1, name: 'Approvals' })).toBeVisible();
    await expect(dual.getByRole('link', { name: poNumber, exact: true })).toHaveCount(0);
    // Another Approver does see it.
    await approver.goto('/approvals');
    await expect(approver.getByRole('link', { name: poNumber, exact: true })).toBeVisible();
    await approver.goto(path);
    await expect(approver.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
  });
});
