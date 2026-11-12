# API contract: Slice 2 — Vendors

Source of truth stays `packages/contracts` (ADR-0008); `openapi.json` is generated. This
is the reviewed design, written before any service code. Paths are under `/api`.

## Constants and schemas (`packages/contracts/src/vendors.ts`, `schemas/vendors.ts`)

```ts
export const VENDOR_NAME_MAX = 200;
export const CONTACT_NAME_MAX = 200;
export const CONTACT_PHONE_MAX = 30;
export const CONTACT_PHONE_PATTERN = /^[0-9 +()-]+$/; // plus: at least one digit
export const NET_DAYS_MAX = 180;
export const ADVANCE_PERCENT_MIN = 1;
export const ADVANCE_PERCENT_MAX = 99;
export const PAYMENT_TERM_TYPES = ['NET', 'ADVANCE', 'PARTIAL_ADVANCE'] as const;
export const VENDOR_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
/** Filter values for the list; ALL is a filter only, never a vendor status. */
export const VENDOR_STATUS_FILTERS = ['ACTIVE', 'INACTIVE', 'ALL'] as const;
export const VENDOR_STATUS_FILTER_DEFAULT = 'ACTIVE';

const netDays = z.int().min(0).max(NET_DAYS_MAX);
export const paymentTerms = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('NET'), netDays }),
  z.strictObject({ type: z.literal('ADVANCE') }),
  z.strictObject({
    type: z.literal('PARTIAL_ADVANCE'),
    advancePercent: z.int().min(ADVANCE_PERCENT_MIN).max(ADVANCE_PERCENT_MAX),
    netDays,
  }),
]).meta({ id: 'PaymentTerms' });

const contactPhone = z.string().trim().min(1).max(CONTACT_PHONE_MAX)
  .regex(CONTACT_PHONE_PATTERN).regex(/[0-9]/);   // "" → TOO_SHORT, bad chars → INVALID_FORMAT

/** Create and full-replacement edit share one body (research R7). */
export const vendorBody = z.strictObject({
  name: z.string().trim().min(1).max(VENDOR_NAME_MAX),
  contactName: z.string().trim().min(1).max(CONTACT_NAME_MAX),
  contactEmail: emailAddressSchema.transform((e) => e.toLowerCase()),
  contactPhone: contactPhone.nullable().optional(),  // omitted or null → stored NULL
  paymentTerms,
}).meta({ id: 'VendorBody' });

export const vendor = z.strictObject({
  id: z.uuid(), name: z.string(), contactName: z.string(), contactEmail: z.string(),
  contactPhone: z.string().nullable(), paymentTerms,
  status: z.enum(VENDOR_STATUSES), deactivatedAt: z.iso.datetime().nullable(),
  version: z.int(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).meta({ id: 'Vendor' });

export const vendorListQuery = z.strictObject({
  ...pageQuery,
  status: z.enum(VENDOR_STATUS_FILTERS).default(VENDOR_STATUS_FILTER_DEFAULT),
  q: z.string().trim().min(1).max(VENDOR_NAME_MAX).optional(), // prefix of vendor_name_key, in SQL
});

export const vendorSnapshot = vendor.pick({ name: true, contactName: true,
  contactEmail: true, contactPhone: true, paymentTerms: true, status: true });

export const vendorHistoryItem = z.strictObject({
  id: z.string(),                         // audit entry id
  action: z.enum(['VENDOR_CREATED', 'VENDOR_UPDATED', 'VENDOR_DEACTIVATED', 'VENDOR_REACTIVATED']),
  occurredAt: z.iso.datetime(),
  actor: z.strictObject({ type: z.enum(['USER', 'SYSTEM', 'OPERATOR']),
    name: z.string().nullable(), email: z.string().nullable(), role: z.string().nullable() }),
  before: vendorSnapshot.nullable(),
  after: vendorSnapshot,
}).meta({ id: 'VendorHistoryItem' });
```

## Access (research R1)

`ACCESS_LEVELS` gains `'role'`; `OperationContract` gains `roles?: readonly UserRole[]`,
required exactly when `access === 'role'` (a contract test refuses either without the
other).

## Operations

| operationId | Method and path | Access | Request | Success | Errors beyond the common set |
|---|---|---|---|---|---|
| `listVendors` | `GET /vendors` | role: BUYER, APPROVER, ADMIN | query `vendorListQuery` | 200 `pageOf(vendor)` | — |
| `getVendor` | `GET /vendors/:id` | role: all three | `idParams` | 200 `vendor`, `ETag` | `NOT_FOUND` |
| `createVendor` | `POST /vendors` | role: BUYER | body `vendorBody` | 201 `vendor`, `ETag`, `Location` | `DUPLICATE_VENDOR_NAME` |
| `updateVendor` | `PUT /vendors/:id` | role: BUYER, `ifMatch` | `idParams`, body `vendorBody` | 200 `vendor`, `ETag` | `NOT_FOUND`, `VERSION_CONFLICT`, `DUPLICATE_VENDOR_NAME` |
| `deactivateVendor` | `POST /vendors/:id/deactivate` | role: BUYER, `ifMatch` | `idParams`, no body | 200 `vendor`, `ETag` | `NOT_FOUND`, `VERSION_CONFLICT`, `INVALID_STATE_TRANSITION` |
| `reactivateVendor` | `POST /vendors/:id/reactivate` | role: BUYER, `ifMatch` | `idParams`, no body | 200 `vendor`, `ETag` | `NOT_FOUND`, `VERSION_CONFLICT`, `INVALID_STATE_TRANSITION` |
| `listVendorHistory` | `GET /vendors/:id/history` | role: BUYER, ADMIN | `idParams`, query `pageQuery` | 200 `pageOf(vendorHistoryItem)` | `NOT_FOUND` |

Common set: `UNAUTHENTICATED`, `ACCESS_TOKEN_EXPIRED`, `SESSION_*`, `CSRF_REJECTED`
(writes), `NO_ROLE_ASSIGNED`, `FORBIDDEN`, `VALIDATION_FAILED`, `PAYLOAD_TOO_LARGE`,
`INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`, `CONCURRENCY_RETRY_EXHAUSTED`.

Sorts: list by `name_key` (unique, so a total order); history by `occurredAt DESC`, then `id DESC`.

## Problem body change (ADR-0007, amended 2026-11-06)

```ts
// errors.ts: ErrorDefinition gains  clash?: 'existingVendor'
DUPLICATE_VENDOR_NAME: { status: 409, title: 'Vendor name already used', fieldDetails: false, clash: 'existingVendor' },

// schemas/problem.ts: one new optional member, refined like `reason`
existingVendor: z.strictObject({ id: z.uuid(), name: z.string() }).optional(),
// refine: present only when ERROR_REGISTRY[code].clash === 'existingVendor'
```

Example:

```json
{ "type": "about:blank", "title": "Vendor name already used", "status": 409,
  "code": "DUPLICATE_VENDOR_NAME", "correlationId": "…",
  "existingVendor": { "id": "6f1c…", "name": "Acme Supplies" } }
```

## Body-schema inventory additions

`createVendor`, `updateVendor`: `name`*, `contactName`*, `contactEmail`*, `contactPhone`,
`paymentTerms`* (* required). `deactivateVendor`, `reactivateVendor`: no body.

## OpenAPI diff (additive only)

- 6 new paths (7 operations), schemas `Vendor`, `VendorBody`, `PaymentTerms`,
  `VendorHistoryItem`, `PageOfVendor`, `PageOfVendorHistoryItem`.
- `Problem` gains optional `existingVendor`.
- `ErrorCode` (`x-extensible-enum`) gains three codes; `FieldError.code` gains one.
- No removed or narrowed field: the breaking-change check stays green.
