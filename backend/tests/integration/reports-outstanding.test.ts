import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { indiaDate, receiptBody } from '../support/receipts.js';
import {
  indiaDaysAgo,
  indiaMidnight,
  reportsHarness,
  type ReportPage,
  type ReportsHarness,
} from '../support/reports.js';

// The outstanding orders report (specs/008-outstanding-report, US1; ADR-0015 amended
// 2026-11-26): approved orders with an open line, by vendor and age band, ages in whole
// India calendar days to the page's as-of date, rows with summary numbers only.

const today = () => indiaDate(new Date());

async function adminOf(h: ReportsHarness) {
  return (await h.caller('{ADMIN}', 'Ada Admin')).jar;
}

async function page(h: ReportsHarness, jar: Parameters<ReportsHarness['report']>[0], q = {}) {
  const res = await h.report(jar, q);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as ReportPage;
}

const ids = (p: ReportPage) => p.items.map((i) => i.id);

describe('[FR-RPT-01] the outstanding orders report', () => {
  it('[FR-RPT-01] lists only approved orders with an open line, with their summary numbers', async () => {
    const h = await reportsHarness();
    const admin = await adminOf(h);
    const open = await h.approvedOn(h.vendorId, [10, 5]);
    const full = await h.approvedOn(h.vendorId, [3]);
    await h.recordReceipt(
      full.id,
      receiptBody(today(), [{ lineId: full.lineIds[0] ?? '', quantity: 3 }]),
    );
    const cancelled = await h.approvedOn(h.vendorId, [4]);
    const approver = await h.approver();
    await h.cancelOrder(cancelled.id, 2, approver.jar, { reason: 'Supplier closed' });
    // A draft and a pending order (above the tier) are not outstanding either.
    await h.createOrder(h.orderBody(), { as: h.jar });
    const pending = (await h.draftAt('150000', h.jar)) as { id: string; version: number };
    await h.submitOrder(pending.id, pending.version, h.jar);

    const report = await page(h, admin);
    expect(ids(report)).toEqual([open.id]);
    const [row] = report.items;
    expect(row).toMatchObject({
      poNumber: open.poNumber,
      vendor: { id: h.vendorId, name: 'Acme Supplies', status: 'ACTIVE' },
      owner: { id: h.buyer.id, name: 'Bea Buyer' },
      approvedOn: today(),
      ageDays: 0,
      ageBucket: 'DAYS_0_30',
      lineCount: 2,
      openLineCount: 2,
      outstandingQuantity: 15,
    });
    expect(report.asOf).toBe(today());
    expect(report.total).toBe(1);
  });

  it('[FR-RPT-03] a partial receipt keeps the order with smaller numbers; the last receipt removes it', async () => {
    const h = await reportsHarness();
    const admin = await adminOf(h);
    const order = await h.approvedOn(h.vendorId, [10, 5]);
    const [a = '', b = ''] = order.lineIds;
    await h.recordReceipt(
      order.id,
      receiptBody(today(), [
        { lineId: a, quantity: 10 },
        { lineId: b, quantity: 2 },
      ]),
    );
    expect((await page(h, admin)).items[0]).toMatchObject({
      id: order.id,
      openLineCount: 1,
      outstandingQuantity: 3,
    });
    await h.recordReceipt(order.id, receiptBody(today(), [{ lineId: b, quantity: 3 }]));
    expect(await page(h, admin)).toMatchObject({ items: [], total: 0 });
  });

  it('[FR-RPT-01] ages are whole India calendar days, and 30, 60 and 90 fall in the lower band', async () => {
    const h = await reportsHarness();
    const admin = await adminOf(h);
    const expected: [number, string][] = [
      [30, 'DAYS_0_30'],
      [31, 'DAYS_31_60'],
      [60, 'DAYS_31_60'],
      [61, 'DAYS_61_90'],
      [90, 'DAYS_61_90'],
      [91, 'OVER_90'],
    ];
    const orders: { id: string }[] = [];
    for (const [days] of expected) {
      const order = await h.approvedOn(h.vendorId);
      await h.approvedDaysAgo(order.id, days);
      orders.push(order);
    }
    // Approved yesterday at 23:50 India time: one calendar day old, though not 24 hours.
    const lateYesterday = await h.approvedOn(h.vendorId);
    await h.plantApproval(
      lateYesterday.id,
      new Date(indiaMidnight(indiaDaysAgo(1)).getTime() + (23 * 60 + 50) * 60_000),
    );
    const report = await page(h, admin, { pageSize: 50 });
    const byId = new Map(report.items.map((i) => [i.id, i]));
    expected.forEach(([days, bucket], i) => {
      expect(byId.get(orders[i]?.id ?? ''), `${String(days)} days`).toMatchObject({
        ageDays: days,
        ageBucket: bucket,
        approvedOn: indiaDaysAgo(days),
      });
    });
    expect(byId.get(lateYesterday.id)).toMatchObject({ ageDays: 1, ageBucket: 'DAYS_0_30' });
  });

  it('[FR-RPT-01] an approval stamped after the as-of date (the database clock ahead) reads as age 0, never negative', async () => {
    const h = await reportsHarness();
    const admin = await adminOf(h);
    const order = await h.approvedOn(h.vendorId);
    // Tomorrow 00:00:05 India time: the database's clock ran past midnight, the API's not.
    await h.plantApproval(order.id, new Date(indiaMidnight(indiaDaysAgo(-1)).getTime() + 5_000));
    const row = (await page(h, admin)).items[0];
    expect(row).toMatchObject({ id: order.id, ageDays: 0, ageBucket: 'DAYS_0_30' });
    expect(ids(await page(h, admin, { ageBucket: 'DAYS_0_30' }))).toEqual([order.id]);
  });

  it('[FR-RPT-01] filters by age band, by vendor, and by both', async () => {
    const h = await reportsHarness();
    const admin = await adminOf(h);
    const other = await h.seedVendor({ name: 'Bright Office Goods' });
    const acmeOld = await h.approvedOn(h.vendorId);
    await h.approvedDaysAgo(acmeOld.id, 120);
    const acmeNew = await h.approvedOn(h.vendorId);
    await h.approvedDaysAgo(acmeNew.id, 10);
    const brightOld = await h.approvedOn(other);
    await h.approvedDaysAgo(brightOld.id, 100);
    const brightMid = await h.approvedOn(other);
    await h.approvedDaysAgo(brightMid.id, 45);

    expect(ids(await page(h, admin, { ageBucket: 'OVER_90' }))).toEqual([acmeOld.id, brightOld.id]);
    expect(ids(await page(h, admin, { ageBucket: 'DAYS_31_60' }))).toEqual([brightMid.id]);
    expect(ids(await page(h, admin, { ageBucket: 'DAYS_61_90' }))).toEqual([]);
    expect(ids(await page(h, admin, { vendorId: other }))).toEqual([brightOld.id, brightMid.id]);
    expect(ids(await page(h, admin, { vendorId: other, ageBucket: 'OVER_90' }))).toEqual([
      brightOld.id,
    ]);
    // A vendor that doesn't exist, or has nothing outstanding: an empty page, not an error.
    expect(await page(h, admin, { vendorId: randomUUID() })).toMatchObject({ items: [], total: 0 });
  });

  it('[FR-RPT-01] pages oldest approval first, each order once, with the true total', async () => {
    const h = await reportsHarness();
    const admin = await adminOf(h);
    const orders: { id: string; days: number }[] = [];
    for (const days of [5, 40, 3, 95, 70]) {
      const order = await h.approvedOn(h.vendorId);
      await h.approvedDaysAgo(order.id, days);
      orders.push({ id: order.id, days });
    }
    const oldestFirst = [...orders].sort((x, y) => y.days - x.days).map((o) => o.id);
    const first = await page(h, admin, { pageSize: 2 });
    const second = await page(h, admin, { pageSize: 2, page: 2 });
    const third = await page(h, admin, { pageSize: 2, page: 3 });
    expect([...ids(first), ...ids(second), ...ids(third)]).toEqual(oldestFirst);
    expect([first.total, second.total, third.total]).toEqual([5, 5, 5]);
    expect(await page(h, admin, { pageSize: 2, page: 9 })).toMatchObject({ items: [], total: 5 });
  });

  it('[FR-RPT-01] an order whose vendor was deactivated after approval stays, its vendor marked inactive', async () => {
    const h = await reportsHarness();
    const admin = await adminOf(h);
    const order = await h.approvedOn(h.vendorId);
    await h.deactivateVendor(h.vendorId);
    expect((await page(h, admin)).items[0]).toMatchObject({
      id: order.id,
      vendor: { id: h.vendorId, status: 'INACTIVE' },
    });
  });

  it('[FR-RPT-01] invalid filters are refused with 400 naming the field', async () => {
    const h = await reportsHarness();
    const admin = await adminOf(h);
    for (const [q, path, code] of [
      [{ ageBucket: 'SOON' }, 'query.ageBucket', 'INVALID_FORMAT'],
      [{ vendorId: 'x' }, 'query.vendorId', 'INVALID_FORMAT'],
      [{ colour: 'red' }, 'query.colour', 'UNKNOWN_FIELD'],
      [{ pageSize: 51 }, 'query.pageSize', 'OUT_OF_RANGE'],
    ] as const) {
      const res = await h.report(admin, q);
      expect(res.status, JSON.stringify(q)).toBe(400);
      expect(res.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: [{ path, code }],
      });
    }
  });
});
