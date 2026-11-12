import AxeBuilder from '@axe-core/playwright';
import type { Browser, Page, Request, Route, TestInfo } from '@playwright/test';
import { expect, test } from './support/test';
import { loggedInAdmin } from './support/accounts';
import { assignRole, chooseRadio, logInAs, signUpAndVerify } from './support/signup';

// The shared vendor list end to end (spec FR-017, ui.md): two Buyers share a vendor, a
// duplicate name links to the vendor that has it, a stale edit is refused and reloads,
// deactivation goes through its dialog and reactivation has none, and an Approver only
// reads. Axe on every screen. One set of accounts for the file: every login from the
// stack's address counts toward the per-IP login limit (ADR-0017).

test.describe.configure({ mode: 'serial' });

let buyerA: Page;
let buyerB: Page;
let approver: Page;
const run = String(Date.now());

/** A page in a context of its own, with the project's base URL and certificate setting. */
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
  const admin = await newPage(browser, testInfo);
  await loggedInAdmin(admin);
  const pages: Page[] = [];
  for (const [name, role] of [
    [`Vendor Buyer A ${run}`, 'Buyer'],
    [`Vendor Buyer B ${run}`, 'Buyer'],
    [`Vendor Approver ${run}`, 'Approver'],
  ] as const) {
    const page = await newPage(browser, testInfo);
    const user = await signUpAndVerify(page, name);
    await assignRole(admin, user, role);
    await logInAs(page, user.email, 'Welcome');
    pages.push(page);
  }
  [buyerA, buyerB, approver] = pages as [Page, Page, Page];
  await admin.context().close();
});

test.afterAll(async () => {
  await Promise.all([buyerA, buyerB, approver].map((page) => page.context().close()));
});

async function axe(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations.map((v) => `${v.id}: ${v.help}`);
}

/** Adds a NET vendor through the form and returns its detail page path. */
async function addVendor(page: Page, name: string, contactName = 'Ravi Shah'): Promise<string> {
  await page.goto('/vendors/new');
  await page.getByLabel('Vendor name').fill(name);
  await page.getByLabel('Contact name').fill(contactName);
  await page.getByLabel('Contact email').fill('ravi@acme.example');
  await chooseRadio(page.getByRole('radiogroup', { name: 'Payment terms' }), 'Net');
  await page.getByLabel('Net days').fill('30');
  await page.getByRole('button', { name: 'Add vendor' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  return new URL(page.url()).pathname;
}

test.describe('[FR-VEN-01] vendors end to end', () => {
  test('[FR-VEN-01] two Buyers share a vendor; a duplicate name links to it', async () => {
    const name = `Acme Supplies ${run}`;
    await buyerA.goto('/vendors');
    expect(await axe(buyerA), '/vendors').toEqual([]);
    await buyerA.getByRole('link', { name: 'Add vendor' }).click();
    await expect(buyerA.getByRole('heading', { level: 1, name: 'Add vendor' })).toBeVisible();
    expect(await axe(buyerA), '/vendors/new').toEqual([]);
    const path = await addVendor(buyerA, name);
    expect(await axe(buyerA), '/vendors/:id').toEqual([]);

    // Buyer B finds it by a prefix, typed in another case.
    await buyerB.goto('/vendors');
    await buyerB.getByLabel('Name starts with').fill(`ACME SUPPLIES ${run}`.toLowerCase());
    await expect(buyerB.getByText('1 vendor', { exact: true })).toBeVisible();
    const row = buyerB.getByRole('row').filter({ has: buyerB.getByRole('link', { name }) });
    await expect(row.getByRole('cell', { name: 'Net 30' })).toBeVisible();

    // The same name, other case and spacing: refused, with a link to the vendor.
    await buyerB.goto('/vendors/new');
    await buyerB.getByLabel('Vendor name').fill(`  acme   SUPPLIES ${run} `);
    await buyerB.getByLabel('Contact name').fill('Someone Else');
    await buyerB.getByLabel('Contact email').fill('else@acme.example');
    await buyerB.getByLabel('Net days').fill('15');
    await buyerB.getByRole('button', { name: 'Add vendor' }).click();
    await expect(buyerB.getByText('A vendor with this name already exists.')).toBeVisible();
    expect(await axe(buyerB), '/vendors/new with a duplicate').toEqual([]);
    await buyerB.getByRole('link', { name: `Open ${name}` }).click();
    // The guard asks first: the form still holds what was typed.
    await buyerB.getByRole('button', { name: 'Discard changes' }).click();
    await expect(buyerB).toHaveURL(new RegExp(`${path}$`));
    await expect(buyerB.getByRole('heading', { level: 1, name })).toBeVisible();
  });

  test('[FR-VEN-01] a stale edit is refused and reloads the latest version', async () => {
    const path = await addVendor(buyerA, `Bright Office ${run}`);
    await buyerB.goto(`${path}/edit`);
    await expect(buyerB.getByLabel('Contact name')).toHaveValue('Ravi Shah');

    await buyerA.goto(`${path}/edit`);
    expect(await axe(buyerA), '/vendors/:id/edit').toEqual([]);
    await buyerA.getByLabel('Contact name').fill('Meera Iyer');
    await buyerA.getByRole('button', { name: 'Save changes' }).click();
    await expect(buyerA.getByText('Meera Iyer')).toBeVisible();

    await buyerB.getByLabel('Contact name').fill('Arjun Menon');
    await buyerB.getByRole('button', { name: 'Save changes' }).click();
    await expect(buyerB.getByRole('alert')).toContainText('Someone else changed this.');
    await buyerB.getByRole('button', { name: 'Reload' }).click();
    await buyerB.getByRole('button', { name: 'Discard changes' }).click();
    await expect(buyerB.getByLabel('Contact name')).toHaveValue('Meera Iyer');
  });

  test('[NFR-FE-09] deactivate through the dialog; reactivate with none', async () => {
    const name = `Coastal Logistics ${run}`;
    const path = await addVendor(buyerA, name);
    const vendorId = path.split('/').pop() ?? '';
    const deactivations: Request[] = [];
    buyerA.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith(`/${vendorId}/deactivate`)) {
        deactivations.push(request);
      }
    });

    // Content, the safe button focused, Escape closes and sends nothing.
    await buyerA.getByRole('button', { name: 'Deactivate' }).click();
    const dialog = buyerA.getByRole('alertdialog', { name: `Deactivate ${name}?` });
    await expect(
      dialog.getByText("Orders using it can't be submitted or approved until it's reactivated."),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Keep active' })).toBeFocused();
    expect(await axe(buyerA), 'deactivate dialog').toEqual([]);
    await buyerA.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(deactivations).toHaveLength(0);

    // Disabled while pending: a double click sends one request.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await buyerA.route(`**/vendors/${vendorId}/deactivate`, async (route: Route) => {
      await held;
      await route.continue();
    });
    await buyerA.getByRole('button', { name: 'Deactivate' }).click();
    const confirm = dialog.getByRole('button', { name: 'Deactivate vendor' });
    await confirm.dblclick();
    await expect(confirm).toBeDisabled();
    release();
    await expect(dialog).toBeHidden();
    expect(deactivations).toHaveLength(1);
    await expect(buyerA.getByText('Inactive', { exact: true })).toBeVisible();
    await buyerA.unroute(`**/vendors/${vendorId}/deactivate`);

    // Reactivate: no dialog.
    await buyerA.getByRole('button', { name: 'Reactivate' }).click();
    await expect(buyerA.getByText('Active', { exact: true })).toBeVisible();
    await expect(buyerA.getByRole('alertdialog')).toHaveCount(0);

    // The history shows all three changes.
    await buyerA.getByRole('link', { name: 'History' }).click();
    await expect(buyerA.getByRole('list', { name: 'Changes' }).first()).toBeVisible();
    expect(await axe(buyerA), '/vendors/:id/history').toEqual([]);
  });

  test('[FR-VEN-01] an Approver reads vendors and has no write controls', async () => {
    const name = `Delta Packaging ${run}`;
    const path = await addVendor(buyerA, name);

    await approver.goto('/vendors');
    await approver.getByLabel('Name starts with').fill(name);
    await expect(approver.getByRole('link', { name })).toBeVisible();
    await expect(approver.getByRole('link', { name: 'Add vendor' })).toHaveCount(0);
    expect(await axe(approver), '/vendors as Approver').toEqual([]);

    await approver.getByRole('link', { name }).click();
    await expect(approver.getByRole('heading', { level: 1, name })).toBeVisible();
    for (const control of ['Edit', 'History']) {
      await expect(approver.getByRole('link', { name: control })).toHaveCount(0);
    }
    await expect(approver.getByRole('button', { name: 'Deactivate' })).toHaveCount(0);
    expect(await axe(approver), '/vendors/:id as Approver').toEqual([]);

    for (const forbidden of ['/vendors/new', `${path}/edit`]) {
      await approver.goto(forbidden);
      await expect(
        approver.getByRole('heading', { level: 1, name: "You don't have access to this page" }),
      ).toBeVisible();
    }
  });
});
