import { describe, expect, it } from 'vitest';
import { indiaDate, receiptBody } from '../support/receipts.js';
import { indiaDaysAgo, reportsHarness, type ReportsHarness } from '../support/reports.js';

// The outstanding report's vendor summary (specs/008-outstanding-report, US2; ADR-0015
// amended 2026-11-26): per vendor with anything outstanding, the orders, the count per
// age band and the oldest approval, oldest first.

interface SummaryPage {
  items: {
    vendor: { id: string; name: string; status: string };
    orderCount: number;
    byBucket: Record<string, number>;
    oldestApprovedOn: string;
  }[];
  page: number;
  pageSize: number;
  total: number;
  asOf: string;
}

async function summary(
  h: ReportsHarness,
  jar: Parameters<ReportsHarness['vendorSummary']>[0],
  q: Record<string, string | number> = {},
) {
  const res = await h.vendorSummary(jar, q);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as SummaryPage;
}

async function aged(h: ReportsHarness, vendorId: string, days: number) {
  const order = await h.approvedOn(vendorId);
  await h.approvedDaysAgo(order.id, days);
  return order;
}

describe('[FR-RPT-01] the outstanding vendor summary', () => {
  it('[FR-RPT-01] one row per vendor with anything outstanding: counts per band and the oldest approval', async () => {
    const h = await reportsHarness();
    const admin = (await h.caller('{ADMIN}', 'Ada Admin')).jar;
    const bright = await h.seedVendor({ name: 'Bright Office Goods' });
    const closed = await h.seedVendor({ name: 'Closed Traders' });
    for (const days of [5, 40, 95]) await aged(h, h.vendorId, days);
    await aged(h, bright, 70);
    // Closed Traders' only order is fully received: not outstanding.
    const done = await h.approvedOn(closed, [2]);
    await h.recordReceipt(
      done.id,
      receiptBody(indiaDate(new Date()), [{ lineId: done.lineIds[0] ?? '', quantity: 2 }]),
    );

    const page = await summary(h, admin);
    expect(page).toMatchObject({ page: 1, pageSize: 20, total: 2, asOf: indiaDate(new Date()) });
    expect(page.items).toEqual([
      {
        vendor: { id: h.vendorId, name: 'Acme Supplies', status: 'ACTIVE' },
        orderCount: 3,
        byBucket: { DAYS_0_30: 1, DAYS_31_60: 1, DAYS_61_90: 0, OVER_90: 1 },
        oldestApprovedOn: indiaDaysAgo(95),
      },
      {
        vendor: { id: bright, name: 'Bright Office Goods', status: 'ACTIVE' },
        orderCount: 1,
        byBucket: { DAYS_0_30: 0, DAYS_31_60: 0, DAYS_61_90: 1, OVER_90: 0 },
        oldestApprovedOn: indiaDaysAgo(70),
      },
    ]);
  });

  it('[FR-RPT-01] pages vendors oldest approval first, then by name; the total counts vendors', async () => {
    const h = await reportsHarness();
    const admin = (await h.caller('{ADMIN}', 'Ada Admin')).jar;
    const zeta = await h.seedVendor({ name: 'Zeta Tools' });
    const beta = await h.seedVendor({ name: 'Beta Paper' });
    await aged(h, zeta, 50);
    await aged(h, beta, 50);
    await aged(h, h.vendorId, 10);
    const first = await summary(h, admin, { pageSize: 2 });
    const second = await summary(h, admin, { pageSize: 2, page: 2 });
    expect([...first.items, ...second.items].map((i) => i.vendor.name)).toEqual([
      'Beta Paper',
      'Zeta Tools',
      'Acme Supplies',
    ]);
    expect([first.total, second.total]).toEqual([3, 3]);
  });

  it('[FR-RPT-01] a vendor deactivated after approval stays, marked inactive', async () => {
    const h = await reportsHarness();
    const admin = (await h.caller('{ADMIN}', 'Ada Admin')).jar;
    await aged(h, h.vendorId, 3);
    await h.deactivateVendor(h.vendorId);
    expect((await summary(h, admin)).items[0]?.vendor).toEqual({
      id: h.vendorId,
      name: 'Acme Supplies',
      status: 'INACTIVE',
    });
  });

  it('[FR-RPT-03] the receipt that completes an order takes it out of the counts', async () => {
    const h = await reportsHarness();
    const admin = (await h.caller('{ADMIN}', 'Ada Admin')).jar;
    const order = await aged(h, h.vendorId, 20);
    await aged(h, h.vendorId, 25);
    expect((await summary(h, admin)).items[0]?.orderCount).toBe(2);
    await h.recordReceipt(
      order.id,
      receiptBody(indiaDate(new Date()), [{ lineId: order.lineIds[0] ?? '', quantity: 10 }]),
    );
    expect((await summary(h, admin)).items[0]).toMatchObject({
      orderCount: 1,
      byBucket: { DAYS_0_30: 1 },
      oldestApprovedOn: indiaDaysAgo(25),
    });
  });

  it('[FR-RPT-01] takes only the page; a filter is an unknown field', async () => {
    const h = await reportsHarness();
    const admin = (await h.caller('{ADMIN}', 'Ada Admin')).jar;
    const res = await h.vendorSummary(admin, { vendorId: h.vendorId });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      details: [{ path: 'query.vendorId', code: 'UNKNOWN_FIELD' }],
    });
  });
});
