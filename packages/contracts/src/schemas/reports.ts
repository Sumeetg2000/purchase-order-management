import { z } from 'zod';
import { AGE_BUCKETS, type AgeBucket } from '../reports.js';
import { VENDOR_STATUSES } from '../vendors.js';
import { pageOf, pageQueryShape } from './pagination.js';

// The outstanding orders report and its vendor summary (specs/008-outstanding-report/
// contracts/api.md, research R1–R3). Rows carry summary numbers only; a row's lines are
// the order's own read (GET /orders/{id}).

export const ageBucket = z.enum(AGE_BUCKETS).meta({ id: 'AgeBucket' });

export const outstandingReportQuery = z.strictObject({
  ...pageQueryShape,
  vendorId: z.uuid().optional(),
  ageBucket: ageBucket.optional(),
});

export const outstandingVendorsQuery = z.strictObject({ ...pageQueryShape });

const reportVendor = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  status: z.enum(VENDOR_STATUSES),
});

export const outstandingOrder = z
  .strictObject({
    id: z.uuid(),
    poNumber: z.string(),
    vendor: reportVendor,
    owner: z.strictObject({ id: z.uuid(), name: z.string() }),
    createdAt: z.iso.datetime(),
    approvedAt: z.iso.datetime(),
    /** The approval's India date. */
    approvedOn: z.iso.date(),
    /** Whole India calendar days from approvedOn to the page's asOf. */
    ageDays: z.int().min(0),
    ageBucket,
    lineCount: z.int().min(1),
    openLineCount: z.int().min(1),
    /** Units still to come across the order's lines. */
    outstandingQuantity: z.int().min(1),
  })
  .meta({ id: 'OutstandingOrder' });

/** One count per age band, its keys built from AGE_BUCKETS. */
const byBucket = z.strictObject(
  Object.fromEntries(AGE_BUCKETS.map((bucket) => [bucket, z.int().min(0)])) as Record<
    AgeBucket,
    z.ZodInt
  >,
);

export const outstandingVendor = z
  .strictObject({
    vendor: reportVendor,
    orderCount: z.int().min(1),
    byBucket,
    oldestApprovedOn: z.iso.date(),
  })
  .meta({ id: 'OutstandingVendor' });

/** The India date the page's ages are counted to. */
const asOf = { asOf: z.iso.date() };

export const outstandingReportPage = pageOf(outstandingOrder)
  .extend(asOf)
  .meta({ id: 'OutstandingReportPage' });

export const outstandingVendorsPage = pageOf(outstandingVendor)
  .extend(asOf)
  .meta({ id: 'OutstandingVendorsPage' });

export type OutstandingReportQuery = z.infer<typeof outstandingReportQuery>;
export type OutstandingOrder = z.infer<typeof outstandingOrder>;
export type OutstandingVendor = z.infer<typeof outstandingVendor>;
