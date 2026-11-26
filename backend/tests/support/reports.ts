import type { CookieJar } from './accounts.js';
import { lineBody } from './orders.js';
import { indiaDate, receiptsHarness } from './receipts.js';

// The real API with a logged-in Buyer, helpers to raise approved orders on a chosen vendor,
// plant their approval date, and read the outstanding report and vendor summary (slice 7
// report tests). The database stamps approvals with its own clock, so an order's age is
// set by planting its approval time below the guards: a fixture, never how an order is
// approved.

/** The India midnight that starts `date` (YYYY-MM-DD), as an instant. */
export function indiaMidnight(date: string): Date {
  return new Date(`${date}T00:00:00+05:30`);
}

/** The India date `days` before today's (the API clock is the real one in these tests). */
export function indiaDaysAgo(days: number): string {
  return indiaDate(new Date(), -days);
}

export async function reportsHarness() {
  const h = await receiptsHarness();
  // The database stamps approvals with its own clock, so the API's runs on the real one:
  // ages and receipt dates are counted against today.
  // setClock logs the Buyer in again: this session is the one to use from here on.
  const jar = await h.setClock(new Date());

  /**
   * An order of one line per quantity on `vendorId` (₹1 a unit, so the submit approves it),
   * raised and submitted through the API by `as`; with its line ids.
   */
  async function approvedOn(
    vendorId: string,
    quantities: number[] = [10],
    as: CookieJar = jar,
  ): Promise<{ id: string; lineIds: string[]; poNumber: string }> {
    const created = await h.createOrder(
      h.orderBody(
        quantities.map((quantity) => lineBody({ quantity, unitPrice: '1' })),
        { vendorId },
      ),
      { as },
    );
    const draft = created.body as { id: string; lines: { id: string }[] };
    const submitted = await h.submitOrder(draft.id, 1, as);
    const order = submitted.body as { id: string; status: string; poNumber: string };
    if (order.status !== 'APPROVED') throw new Error(`expected APPROVED, got ${order.status}`);
    return { id: order.id, lineIds: draft.lines.map((l) => l.id), poNumber: order.poNumber };
  }

  /** Plants an order's approval (and its round's close) at `at`, its raising before it. */
  async function plantApproval(orderId: string, at: Date) {
    await h.query('BEGIN');
    await h.query('SET LOCAL session_replication_role = replica');
    await h.query(
      `UPDATE purchase_orders
          SET approved_at = $2, submitted_at = $2::timestamptz - interval '1 hour',
              created_at = $2::timestamptz - interval '2 hours'
        WHERE id = $1`,
      [orderId, at.toISOString()],
    );
    await h.query(
      `UPDATE approval_rounds
          SET submitted_at = $2::timestamptz - interval '1 hour', closed_at = $2
        WHERE order_id = $1`,
      [orderId, at.toISOString()],
    );
    await h.query('COMMIT');
  }

  /** Approved `days` India calendar days before today, at 10:00 India time. */
  function approvedDaysAgo(orderId: string, days: number) {
    const at = new Date(indiaMidnight(indiaDaysAgo(days)).getTime() + 10 * 3_600_000);
    return plantApproval(orderId, at);
  }

  /** Marks a vendor inactive below the guards (as a deactivation after approval would). */
  async function deactivateVendor(vendorId: string) {
    await h.query('BEGIN');
    await h.query('SET LOCAL session_replication_role = replica');
    await h.query(`UPDATE vendors SET status = 'INACTIVE', deactivated_at = now() WHERE id = $1`, [
      vendorId,
    ]);
    await h.query('COMMIT');
  }

  function query(values: Record<string, string | number>): string {
    const qs = new URLSearchParams(
      Object.entries(values).map(([k, v]) => [k, String(v)] as [string, string]),
    ).toString();
    return qs ? `?${qs}` : '';
  }

  /** GET /reports/outstanding. */
  function report(as: CookieJar = jar, values: Record<string, string | number> = {}) {
    return h.get(`/reports/outstanding${query(values)}`, as);
  }

  /** GET /reports/outstanding/vendors. */
  function vendorSummary(as: CookieJar = jar, values: Record<string, string | number> = {}) {
    return h.get(`/reports/outstanding/vendors${query(values)}`, as);
  }

  /** A logged-in user with these roles. */
  async function caller(roles: string, name = 'Ola Reader') {
    const user = await h.seedUser({ roles, name });
    return { ...user, jar: await h.loggedIn(user) };
  }

  return {
    ...h,
    jar,
    approvedOn,
    plantApproval,
    approvedDaysAgo,
    deactivateVendor,
    report,
    vendorSummary,
    caller,
  };
}

export type ReportsHarness = Awaited<ReturnType<typeof reportsHarness>>;

/** The report page as the API returns it. */
export interface ReportPage {
  items: {
    id: string;
    poNumber: string;
    vendor: { id: string; name: string; status: string };
    owner: { id: string; name: string };
    createdAt: string;
    approvedAt: string;
    approvedOn: string;
    ageDays: number;
    ageBucket: string;
    lineCount: number;
    openLineCount: number;
    outstandingQuantity: number;
  }[];
  page: number;
  pageSize: number;
  total: number;
  asOf: string;
}
