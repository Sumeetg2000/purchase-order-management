import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './support/test';
import { loggedInAdmin } from './support/accounts';
import { assignRole, logInAs, signUpAndVerify } from './support/signup';

// The order editor's targets (ADR-0012, SC-008) with a 500-line order under 4× CPU
// throttling: from Edit to an editable first line within 1,000 ms; a keystroke painted
// within 50 ms and adding or removing a line within 100 ms, at the 95th percentile.
// Chromium only: the throttling is a DevTools Protocol setting.

const LOAD_MS = 1_000;
const KEYSTROKE_P95_MS = 50;
const ADD_REMOVE_P95_MS = 100;

function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? Infinity;
}

/** A 500-line draft raised through the API with the page's own session. */
async function fiveHundredLineOrder(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === 'po_csrf')?.value ?? '';
  const origin = new URL(page.url()).origin;
  const vendors = await page.request.get('/api/vendors?q=Acme');
  const vendorId = ((await vendors.json()) as { items: { id: string }[] }).items[0]?.id;
  const created = await page.request.post('/api/orders', {
    headers: { 'X-CSRF-Token': csrf, Origin: origin, 'Idempotency-Key': randomUUID() },
    data: {
      vendorId,
      lines: Array.from({ length: 500 }, (_, i) => ({
        description: `Part ${String(i + 1)}`,
        quantity: (i % 9) + 1,
        unitPrice: '12.3456',
      })),
    },
  });
  expect(created.status()).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

/** Milliseconds from adding (or removing the first) line to the second frame after it. */
function timeToPaint(page: Page, action: 'add' | 'remove'): Promise<number> {
  return page.evaluate(async (which) => {
    const button =
      which === 'add'
        ? [...document.querySelectorAll('button')].find((b) => b.textContent === 'Add line')
        : document.querySelector<HTMLButtonElement>('button[aria-label="Remove line 1"]');
    if (!button) throw new Error(`no ${which} button`);
    const start = performance.now();
    button.click();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });
    return performance.now() - start;
  }, action);
}

test('[NFR-FE-06] a 500-line order: open, type, add and remove within the targets', async ({
  page,
  browserName,
  browser,
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'CPU throttling is a Chromium DevTools setting');
  testInfo.setTimeout(180_000);
  const run = String(Date.now());
  const adminPage = await browser.newPage({
    ...(testInfo.project.use.baseURL ? { baseURL: testInfo.project.use.baseURL } : {}),
    ignoreHTTPSErrors: true,
  });
  await loggedInAdmin(adminPage);
  const user = await signUpAndVerify(page, `Perf Buyer ${run}`);
  await assignRole(adminPage, user, 'Buyer');
  await adminPage.context().close();
  await logInAs(page, user.email, 'Welcome');
  const id = await fiveHundredLineOrder(page);

  await page.goto(`/orders/${id}`);
  await expect(page.getByRole('link', { name: 'Edit' })).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

  // Timed in the page, from the click to the first frame painted with line 1 editable:
  // an expect() poll from the test would add its own retry interval to the time.
  const loadMs = await page.evaluate(async () => {
    const edit = [...document.querySelectorAll('a')].find((a) => a.textContent === 'Edit');
    if (!edit) throw new Error('no Edit link');
    const start = performance.now();
    edit.click();
    return new Promise<number>((resolve) => {
      const check = () => {
        const input = document.querySelector<HTMLInputElement>(
          'input[aria-label="Description, line 1"]',
        );
        if (input && !input.disabled && !input.readOnly) {
          requestAnimationFrame(() => {
            resolve(performance.now() - start);
          });
        } else {
          requestAnimationFrame(check);
        }
      };
      requestAnimationFrame(check);
    });
  });
  await expect(page.getByLabel('Description, line 1', { exact: true })).toBeEditable();

  // Each keystroke's time from keydown to the second frame after it.
  await page.evaluate(() => {
    const samples: number[] = [];
    (window as unknown as { keystrokes: number[] }).keystrokes = samples;
    document.addEventListener(
      'keydown',
      (event) => {
        const start = event.timeStamp;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => samples.push(performance.now() - start));
        });
      },
      true,
    );
  });
  await page.getByLabel('Description, line 1', { exact: true }).click();
  await page.keyboard.type(' with a longer description', { delay: 60 });
  await page.waitForTimeout(200);
  const keystrokes = await page.evaluate(
    () => (window as unknown as { keystrokes: number[] }).keystrokes,
  );

  const addRemove: number[] = [];
  for (let i = 0; i < 10; i += 1) {
    addRemove.push(await timeToPaint(page, 'add'));
    addRemove.push(await timeToPaint(page, 'remove'));
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  const results = { loadMs, keystrokeP95: p95(keystrokes), addRemoveP95: p95(addRemove) };
  testInfo.annotations.push({ type: 'editor-timings', description: JSON.stringify(results) });
  console.info(`order editor at 4× CPU throttling: ${JSON.stringify(results)}`);
  expect(keystrokes.length).toBeGreaterThan(20);
  expect(results.loadMs).toBeLessThanOrEqual(LOAD_MS);
  expect(results.keystrokeP95).toBeLessThanOrEqual(KEYSTROKE_P95_MS);
  expect(results.addRemoveP95).toBeLessThanOrEqual(ADD_REMOVE_P95_MS);
});
