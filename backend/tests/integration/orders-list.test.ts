import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CookieJar } from '../support/accounts.js';
import { lineBody, ordersHarness, type OrdersHarness } from '../support/orders.js';

// Order lists (spec US5; FR-015, FR-016, FR-024; research R7, R11): scoped in the database
// to what the caller may read, filtered there, paginated newest first (by PO number,
// newest first, with a PO-number prefix), each row with its line count, and the rows and
// the total read in one statement.

interface Item {
  id: string;
  poNumber: string;
  status: string;
  vendor: { id: string; name: string };
  owner: { id: string; name: string };
  total: string;
  lineCount: number;
  createdAt: string;
}
interface Page {
  items: Item[];
  page: number;
  pageSize: number;
  total: number;
}

async function list(
  h: OrdersHarness,
  query: Record<string, string | number>,
  as: CookieJar = h.jar,
) {
  const search = new URLSearchParams(
    Object.entries(query).map(([k, v]): [string, string] => [k, String(v)]),
  );
  const res = await h.get(`/orders?${search.toString()}`, as);
  return { res, body: res.body as Page };
}

/** Runs SQL as the superuser with triggers off: sets states no API path reaches yet. */
async function plant(h: OrdersHarness, sql: string, params: unknown[]) {
  await h.query('BEGIN');
  await h.query('SET LOCAL session_replication_role = replica');
  await h.query(sql, params);
  await h.query('COMMIT');
}

async function setup() {
  const h = await ordersHarness();
  const other = await h.seedUser({ roles: '{BUYER}', name: 'Omar Other' });
  const otherJar = await h.loggedIn(other);
  const beta = await h.seedVendor({ name: 'Beta Traders' });
  const create = async (as: CookieJar, lines: number, vendorId = h.vendorId) => {
    const res = await h.createOrder(
      {
        vendorId,
        lines: Array.from({ length: lines }, () => lineBody({ quantity: 1, unitPrice: '2' })),
      },
      { as },
    );
    expect(res.status).toBe(201);
    return res.body as Item;
  };
  // Buyer A: three orders (one with Beta); Buyer B: two.
  const a1 = await create(h.jar, 1);
  const a2 = await create(h.jar, 2, beta);
  const a3 = await create(h.jar, 3);
  const b1 = await create(otherJar, 1);
  const b2 = await create(otherJar, 4, beta);
  return { h, other, otherJar, beta, a: [a1, a2, a3], b: [b1, b2] };
}

const ids = (page: Page) => page.items.map((i) => i.id);

describe('[FR-OWN-01] order lists are scoped in the database', () => {
  it('[FR-OWN-01] a Buyer lists their own orders, newest first, with line counts and totals', async () => {
    const { h, a } = await setup();
    const { res, body } = await list(h, {});
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ page: 1, pageSize: 20, total: 3 });
    expect(ids(body)).toEqual([a[2]?.id, a[1]?.id, a[0]?.id]);
    expect(body.items[0]).toEqual({
      id: a[2]?.id,
      poNumber: a[2]?.poNumber,
      status: 'DRAFT',
      vendor: { id: h.vendorId, name: 'Acme Supplies' },
      owner: { id: h.buyer.id, name: 'Bea Buyer' },
      total: '6.0000',
      lineCount: 3,
      createdAt: a[2]?.createdAt,
    });
  });

  it('[FR-OWN-01] an Admin lists every order; an Approver none of the drafts', async () => {
    const { h, a, b } = await setup();
    const admin = await h.loggedIn(await h.seedUser({ roles: '{ADMIN}' }));
    const all = await list(h, {}, admin);
    expect(all.body.total).toBe(5);
    expect(new Set(ids(all.body))).toEqual(new Set([...a, ...b].map((o) => o.id)));
    const approver = await h.loggedIn(await h.seedUser({ roles: '{APPROVER}' }));
    expect((await list(h, {}, approver)).body).toMatchObject({ items: [], total: 0 });
    // Once an order leaves DRAFT, an Approver sees it.
    await plant(h, `UPDATE purchase_orders SET status = 'PENDING_APPROVAL' WHERE id = $1`, [
      b[0]?.id,
    ]);
    expect(ids((await list(h, {}, approver)).body)).toEqual([b[0]?.id]);
  });

  it('[FR-OWN-01] a Buyer+Approver gets one list: their own orders and every non-draft order', async () => {
    const { h, b } = await setup();
    const both = await h.seedUser({ roles: '{BUYER,APPROVER}' });
    const jar = await h.loggedIn(both);
    const res = await h.createOrder(h.orderBody([lineBody()]), { as: jar });
    const own = res.body as Item;
    await plant(h, `UPDATE purchase_orders SET status = 'APPROVED' WHERE id = $1`, [b[1]?.id]);
    const page = (await list(h, {}, jar)).body;
    expect(page.total).toBe(2);
    expect(ids(page)).toEqual([own.id, b[1]?.id]);
  });
});

describe('[FR-PO-01] order list filters', () => {
  it('[FR-PO-01] by status and by vendor, alone and combined', async () => {
    const { h, a, beta } = await setup();
    expect((await list(h, { status: 'DRAFT' })).body.total).toBe(3);
    expect((await list(h, { status: 'APPROVED' })).body.total).toBe(0);
    expect(ids((await list(h, { vendorId: beta })).body)).toEqual([a[1]?.id]);
    expect(ids((await list(h, { vendorId: beta, status: 'DRAFT' })).body)).toEqual([a[1]?.id]);
  });

  it('[FR-PO-01] by PO-number prefix, case-insensitive, sorted by PO number newest first', async () => {
    const { h, a } = await setup();
    const fy = a[0]?.poNumber.slice(0, 'PO-2026-27-'.length) ?? '';
    const page = (await list(h, { poNumber: fy.toLowerCase() })).body;
    expect(page.items.map((i) => i.poNumber)).toEqual([a[2], a[1], a[0]].map((o) => o?.poNumber));
    // Make creation order disagree with PO-number order: the prefix list keeps PO order.
    await plant(
      h,
      `UPDATE purchase_orders SET created_at = now() + interval '1 hour' WHERE id = $1`,
      [a[0]?.id],
    );
    expect(ids((await list(h, {})).body)[0]).toBe(a[0]?.id);
    expect(ids((await list(h, { poNumber: fy })).body)).toEqual(
      [a[2], a[1], a[0]].map((o) => o?.id),
    );
    const exact = (await list(h, { poNumber: a[1]?.poNumber ?? '' })).body;
    expect(ids(exact)).toEqual([a[1]?.id]);
    expect((await list(h, { poNumber: 'PO-1999' })).body.total).toBe(0);
  });

  it('[FR-PO-01] by created date, inclusive calendar days in India, at both day edges', async () => {
    const { h, a } = await setup();
    const set = (id: string | undefined, at: string) =>
      plant(h, `UPDATE purchase_orders SET created_at = $2 WHERE id = $1`, [id, at]);
    await set(a[0]?.id, '2026-04-30T18:29:59.999+00:00'); // 30 April 23:59:59.999 IST
    await set(a[1]?.id, '2026-04-30T18:30:00+00:00'); // 1 May 00:00 IST
    await set(a[2]?.id, '2026-05-31T18:29:59+00:00'); // 31 May 23:59:59 IST
    expect(ids((await list(h, { createdTo: '2026-04-30' })).body)).toEqual([a[0]?.id]);
    expect(ids((await list(h, { createdFrom: '2026-05-01' })).body)).toEqual([a[2]?.id, a[1]?.id]);
    expect(
      ids((await list(h, { createdFrom: '2026-05-01', createdTo: '2026-05-31' })).body),
    ).toEqual([a[2]?.id, a[1]?.id]);
    expect((await list(h, { createdFrom: '2026-05-02', createdTo: '2026-05-30' })).body.total).toBe(
      0,
    );
    const backwards = await list(h, { createdFrom: '2026-05-02', createdTo: '2026-05-01' });
    expect(backwards.res.status).toBe(400);
    expect(backwards.res.body).toMatchObject({
      details: [{ path: 'query.createdTo', code: 'OUT_OF_RANGE' }],
    });
  });

  it('[NFR-PERF-01] pages: a page past the end is empty with the right total', async () => {
    const { h, a } = await setup();
    const first = (await list(h, { pageSize: 2 })).body;
    expect(first).toMatchObject({ total: 3, pageSize: 2 });
    expect(ids(first)).toEqual([a[2]?.id, a[1]?.id]);
    expect(ids((await list(h, { pageSize: 2, page: 2 })).body)).toEqual([a[0]?.id]);
    expect((await list(h, { pageSize: 2, page: 9 })).body).toMatchObject({ items: [], total: 3 });
  });

  it("[FR-VEN-02] the vendor dialog's count: the caller's own drafts with that vendor", async () => {
    const { h, otherJar, beta } = await setup();
    expect((await list(h, { vendorId: beta, status: 'DRAFT', pageSize: 1 })).body.total).toBe(1);
    expect(
      (await list(h, { vendorId: beta, status: 'DRAFT', pageSize: 1 }, otherJar)).body.total,
    ).toBe(1);
    expect(
      (await list(h, { vendorId: randomUUID(), status: 'DRAFT', pageSize: 1 })).body.total,
    ).toBe(0);
  });

  it('[NFR-VAL-01] an unknown filter is refused', async () => {
    const { h } = await setup();
    const res = await list(h, { total: '1' });
    expect(res.res.status).toBe(400);
    expect(res.res.body).toMatchObject({
      details: [{ path: 'query.total', code: 'UNKNOWN_FIELD' }],
    });
  });
});
