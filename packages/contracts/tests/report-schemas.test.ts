import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  AGE_BUCKET_UPPER_DAYS,
  AGE_BUCKETS,
  fieldErrors,
  outstandingOrder,
  outstandingReportPage,
  outstandingReportQuery,
  outstandingVendor,
  outstandingVendorsPage,
  outstandingVendorsQuery,
} from '../src/index.js';

// The slice 7 report schemas (specs/008-outstanding-report/contracts/api.md, research R1,
// R3), reviewed before any service code. Failures are read through fieldErrors, the API's
// own issue → field code mapping.

const ORDER_ID = '0192f0c4-1c2d-7e3f-8a4b-5c6d7e8f9a0c';
const VENDOR_ID = '0192f0c4-1c2d-7e3f-8a4b-5c6d7e8f9a0d';
const USER_ID = '0192f0c4-1c2d-7e3f-8a4b-5c6d7e8f9a0e';

function failures(schema: z.ZodType, value: unknown): string[] {
  const result = schema.safeParse(value, { reportInput: true });
  if (result.success) return [];
  return fieldErrors('query', result.error.issues).map((e) => `${e.path} ${e.code}`);
}

const vendor = { id: VENDOR_ID, name: 'Acme Supplies', status: 'ACTIVE' };

const item = (extra: Record<string, unknown> = {}) => ({
  id: ORDER_ID,
  poNumber: 'PO-2026-27-000123',
  vendor,
  owner: { id: USER_ID, name: 'Riya Buyer' },
  createdAt: '2026-09-01T04:30:00.000Z',
  approvedAt: '2026-09-01T06:30:00.000Z',
  approvedOn: '2026-09-01',
  ageDays: 86,
  ageBucket: 'DAYS_61_90',
  lineCount: 5,
  openLineCount: 2,
  outstandingQuantity: 70,
  ...extra,
});

describe('[FR-RPT-01] outstanding report schemas', () => {
  it('[FR-RPT-01] four age buckets with upper bounds 30, 60 and 90 days', () => {
    expect(AGE_BUCKETS).toEqual(['DAYS_0_30', 'DAYS_31_60', 'DAYS_61_90', 'OVER_90']);
    expect(AGE_BUCKET_UPPER_DAYS).toEqual([30, 60, 90]);
  });

  it('[FR-RPT-01] the report query: page defaults, optional vendor and bucket, nothing else', () => {
    expect(outstandingReportQuery.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(
      outstandingReportQuery.parse({ vendorId: VENDOR_ID, ageBucket: 'OVER_90', page: '2' }),
    ).toEqual({ page: 2, pageSize: 20, vendorId: VENDOR_ID, ageBucket: 'OVER_90' });
    expect(failures(outstandingReportQuery, { ageBucket: 'SOON' })).toEqual([
      'query.ageBucket INVALID_FORMAT',
    ]);
    expect(failures(outstandingReportQuery, { vendorId: 'x' })).toEqual([
      'query.vendorId INVALID_FORMAT',
    ]);
    expect(failures(outstandingReportQuery, { colour: 'red' })).toEqual([
      'query.colour UNKNOWN_FIELD',
    ]);
    expect(failures(outstandingReportQuery, { pageSize: '51' })).toEqual([
      'query.pageSize OUT_OF_RANGE',
    ]);
  });

  it('[FR-RPT-01] the vendor summary query takes only the page', () => {
    expect(outstandingVendorsQuery.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(failures(outstandingVendorsQuery, { vendorId: VENDOR_ID })).toEqual([
      'query.vendorId UNKNOWN_FIELD',
    ]);
  });

  it('[FR-RPT-01] a report row carries summary numbers, never its lines', () => {
    expect(outstandingOrder.parse(item())).toEqual(item());
    expect(outstandingOrder.safeParse(item({ openLines: [] })).success).toBe(false);
    // Outstanding means at least one unit still to come.
    expect(outstandingOrder.safeParse(item({ outstandingQuantity: 0 })).success).toBe(false);
    expect(outstandingOrder.safeParse(item({ ageBucket: 'SOON' })).success).toBe(false);
  });

  it('[FR-RPT-01] a vendor summary row has exactly the four bucket counts', () => {
    const row = {
      vendor,
      orderCount: 4,
      byBucket: { DAYS_0_30: 1, DAYS_31_60: 0, DAYS_61_90: 2, OVER_90: 1 },
      oldestApprovedOn: '2026-07-01',
    };
    expect(outstandingVendor.parse(row)).toEqual(row);
    expect(Object.keys(outstandingVendor.shape.byBucket.shape)).toEqual([...AGE_BUCKETS]);
    const three = { DAYS_0_30: 1, DAYS_31_60: 0, DAYS_61_90: 2 };
    expect(outstandingVendor.safeParse({ ...row, byBucket: three }).success).toBe(false);
  });

  it('[FR-RPT-01] both pages carry the India date their ages are counted to', () => {
    const page = { items: [item()], page: 1, pageSize: 20, total: 1, asOf: '2026-11-26' };
    expect(outstandingReportPage.parse(page)).toEqual(page);
    const noAsOf = { items: [item()], page: 1, pageSize: 20, total: 1 };
    expect(outstandingReportPage.safeParse(noAsOf).success).toBe(false);
    expect(
      outstandingVendorsPage.safeParse({ items: [], page: 1, pageSize: 20, total: 0 }).success,
    ).toBe(false);
  });
});
