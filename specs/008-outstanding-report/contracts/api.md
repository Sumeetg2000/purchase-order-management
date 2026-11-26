# API contract: Slice 7 — Outstanding orders report

Zod first (`packages/contracts`), OpenAPI generated; both changes are additive (two new
operations, new schemas, a new enum published as `x-extensible-enum`): no `breaking`
label. Decisions in [research.md](../research.md) R1–R3.

## New constants and schemas

`packages/contracts/src/reports.ts`:
- `AGE_BUCKETS`, `AgeBucket`, `AGE_BUCKET_UPPER_DAYS` (data-model.md)

`packages/contracts/src/schemas/reports.ts`:

```ts
outstandingReportQuery = z.strictObject({
  ...pageQueryShape,
  vendorId: z.uuid().optional(),
  ageBucket: z.enum(AGE_BUCKETS).optional(),
})

outstandingVendorsQuery = z.strictObject({ ...pageQueryShape })

outstandingOrder = z.strictObject({
  id: z.uuid(), poNumber: z.string(),
  vendor: z.strictObject({ id: z.uuid(), name: z.string(), status: vendorStatus }),
  owner: z.strictObject({ id: z.uuid(), name: z.string() }),
  createdAt: z.iso.datetime(), approvedAt: z.iso.datetime(), approvedOn: z.iso.date(),
  ageDays: z.number().int().min(0), ageBucket: z.enum(AGE_BUCKETS),
  lineCount: z.number().int(), openLineCount: z.number().int(),
  // Units still to come across the order's lines; line detail is GET /orders/{id}.
  outstandingQuantity: z.number().int().min(1),
})

outstandingVendor = z.strictObject({
  vendor: z.strictObject({ id: z.uuid(), name: z.string(), status: vendorStatus }),
  orderCount: z.number().int(),
  byBucket: z.strictObject({ DAYS_0_30: int, DAYS_31_60: int, DAYS_61_90: int, OVER_90: int }),
  oldestApprovedOn: z.iso.date(),
})

// The page envelope plus the India date the ages are counted to.
outstandingReportPage = pageOf(outstandingOrder).extend({ asOf: z.iso.date() })
outstandingVendorsPage = pageOf(outstandingVendor).extend({ asOf: z.iso.date() })
```

`byBucket` keys are built from `AGE_BUCKETS` (one list), not written out.

## New operations (`operations.ts`)

| operationId | Method, path | Access | Request | 200 |
|---|---|---|---|---|
| `listOutstandingOrders` | `GET /reports/outstanding` | `role`: BUYER, APPROVER, ADMIN | `query: outstandingReportQuery` | `OutstandingReportPage` |
| `listOutstandingVendors` | `GET /reports/outstanding/vendors` | `role`: BUYER, APPROVER, ADMIN | `query: outstandingVendorsQuery` | `OutstandingVendorsPage` |

Scope (R2): Buyer-only callers get their own orders; any caller holding APPROVER or ADMIN
gets all.

## Errors (no new code)

| Case | Answer |
|---|---|
| anonymous | `401 UNAUTHENTICATED` |
| no role | `403 NO_ROLE_ASSIGNED` |
| unknown query field | `400 VALIDATION_FAILED`, `UNKNOWN_FIELD` |
| `ageBucket` not in `AGE_BUCKETS`, `vendorId` not a UUID, bad page/pageSize | `400 VALIDATION_FAILED`, `INVALID_FORMAT` / `OUT_OF_RANGE` |
| `vendorId` of no vendor, or with nothing outstanding | `200`, empty page |
| page past the last | `200`, empty page, true `total` |

## Changed (no contract change)

- `GET /admin/access-requests`: same contract; its repository becomes one raw statement
  (R9).

## OpenAPI diff (expected)

Added: 2 paths, schemas `OutstandingReportQuery`-derived parameters, `OutstandingOrder`,
`OutstandingVendor`, `OutstandingReportPage`,
`OutstandingVendorsPage`, `AgeBucket` (extensible enum). Nothing removed or narrowed.
