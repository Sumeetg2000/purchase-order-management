# API contract: Slice 3 — Draft orders

Source of truth stays `packages/contracts` (ADR-0008); `openapi.json` is generated. This
is the reviewed design, written before any service code. Paths are under `/api`.

## Money (`packages/contracts/src/money.ts`, research R1)

```ts
import Big from 'big.js';
Big.strict = true;                                   // a JS number passed to Big throws

export const MONEY_SCALE = 4;
export const MONEY_PATTERN = /^\d{1,18}\.\d{4}$/;    // responses: always 4 places
export const UNIT_PRICE_INPUT_PATTERN = /^\d{1,9}(\.\d{1,4})?$/;

export const money = z.string().regex(MONEY_PATTERN).brand<'Money'>().meta({ id: 'Money' });
export type Money = z.infer<typeof money>;

export function toMoney(value: string): Money;                    // normalises to 4 places
export function lineTotal(quantity: number, unitPrice: Money): Money;  // quantity is an int
export function sum(values: readonly Money[]): Money;
export function formatInr(value: Money): string;                  // en-IN, 2–4 places
```

`quantity` is a whole number (≤ 1,000,000), so passing it as `number` is exact; it goes
through `new Big(String(quantity))`.

## Constants and schemas (`packages/contracts/src/orders.ts`, `schemas/orders.ts`)

```ts
export const ORDER_LINES_MIN = 1;
export const ORDER_LINES_MAX = 500;
export const LINE_DESCRIPTION_MAX = 500;            // Unicode code points
export const LINE_QUANTITY_MAX = 1_000_000;
export const UNIT_PRICE_MAX = '999999999.9999';
export const DELETE_REASON_MAX = 500;
export const ORDER_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export const PO_NUMBER_PATTERN = /^PO-\d{4}-\d{2}-\d{6,}$/;
export const PO_NUMBER_TIME_ZONE = 'Asia/Kolkata';
export const ORDER_BODY_LIMIT_BYTES = 4 * 1024 * 1024;  // R8; nginx pinned to it
export const IDEMPOTENCY_KEY_TTL_HOURS = 24;
export const ORDER_ADMIN_READ_ONLY_MESSAGE = 'Admins can view orders but not change them.';
/** Derived or system-assigned: refused in any body with READ_ONLY_FIELD (ADR-0003). */
export const ORDER_READ_ONLY_FIELDS = ['total', 'lineTotal', 'receivedQuantity',
  'outstandingQuantity', 'openLineCount', 'poNumber', 'position', 'version', 'status',
  'owner', 'ownerId', 'createdAt', 'updatedAt', 'lineCount'] as const;

const codePoints = (s: string) => [...s].length;
const description = z.string().trim()
  .refine((s) => s.isWellFormed(), { params: { code: 'INVALID_FORMAT' } })
  .refine((s) => !/\p{Cc}/u.test(s), { params: { code: 'INVALID_FORMAT' } })
  .refine((s) => codePoints(s) >= 1, { params: { code: 'TOO_SHORT' } })
  .refine((s) => codePoints(s) <= LINE_DESCRIPTION_MAX, { params: { code: 'TOO_LONG' } });

const unitPrice = z.string().regex(UNIT_PRICE_INPUT_PATTERN).transform(toMoney);  // ≤ max by pattern
const quantity = z.int().min(1).max(LINE_QUANTITY_MAX);

const lineInput = readOnlyGuarded(z.strictObject({
  id: z.uuid().optional(),                         // present → update that line (edit only)
  description, quantity, unitPrice,
}), ORDER_READ_ONLY_FIELDS);

const lines = z.array(lineInput).min(ORDER_LINES_MIN).max(ORDER_LINES_MAX);

export const createOrderBody = readOnlyGuarded(z.strictObject({
  vendorId: z.uuid(),
  lines: z.array(lineInput.omit({ id: true })).min(ORDER_LINES_MIN).max(ORDER_LINES_MAX),
}), ORDER_READ_ONLY_FIELDS).meta({ id: 'CreateOrderBody' });

/** Full intended state (ADR-0009): the vendor and the whole line set. */
export const editOrderBody = readOnlyGuarded(z.strictObject({ vendorId: z.uuid(), lines }),
  ORDER_READ_ONLY_FIELDS).meta({ id: 'EditOrderBody' });

export const deleteOrderBody = z.strictObject({
  reason: z.string().trim()/* well-formed; control chars except \n refused */
    .min(1).max(DELETE_REASON_MAX).nullable().optional(),
}).meta({ id: 'DeleteOrderBody' });

export const orderLine = z.strictObject({
  id: z.uuid(), description: z.string(), quantity: z.int(), unitPrice: money, lineTotal: money,
}).meta({ id: 'OrderLine' });

export const order = z.strictObject({
  id: z.uuid(), poNumber: z.string().regex(PO_NUMBER_PATTERN), status: z.enum(ORDER_STATUSES),
  vendor: z.strictObject({ id: z.uuid(), name: z.string(), status: z.enum(VENDOR_STATUSES) }),
  owner: z.strictObject({ id: z.uuid(), name: z.string() }),
  total: money, lineCount: z.int(), lines: z.array(orderLine),
  version: z.int(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).meta({ id: 'Order' });

export const orderListItem = order.omit({ lines: true, version: true, updatedAt: true })
  .extend({ vendor: z.strictObject({ id: z.uuid(), name: z.string() }) })
  .meta({ id: 'OrderListItem' });

export const orderListQuery = pageQuery.extend({
  status: z.enum(ORDER_STATUSES).optional(),
  vendorId: z.uuid().optional(),
  poNumber: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9-]+$/)
    .transform((s) => s.toUpperCase()).optional(),          // prefix
  createdFrom: z.iso.date().optional(),                       // inclusive, IST
  createdTo: z.iso.date().optional(),
}).refine((q) => !q.createdFrom || !q.createdTo || q.createdFrom <= q.createdTo,
  { path: ['createdTo'], params: { code: 'OUT_OF_RANGE' } });

export const orderTimelineItem = historyItem;               // slice 2's shape, reused
```

`readOnlyGuarded` (new, `schemas/read-only.ts`) runs before the strict-object check and
reports each listed key as `READ_ONLY_FIELD` instead of `UNKNOWN_FIELD`, so a body sending
`total` gets the specific code (ADR-0003). Vendors keep `UNKNOWN_FIELD` (no change).

Headers: `idempotencyKeyHeader = z.uuid()` on create (required, R5); `If-Match` on edit and
delete via slice 2's `ifMatch`.

## Access

Uses slice 2's `role` access level. Order-level scoping (owner, Admin, Approver) is in the
service, against the order loaded under lock (ADR-0004 precedence: route-level `403`
before validation, `404` before order-level `403`).

## Operations

| operationId | Method and path | Access | Request | Success | Errors beyond the common set |
|---|---|---|---|---|---|
| `listOrders` | `GET /orders` | role: BUYER, APPROVER, ADMIN | query `orderListQuery` | 200 `pageOf(orderListItem)` | — |
| `getOrder` | `GET /orders/:id` | role: all three | `idParams` | 200 `order`, `ETag` | `NOT_FOUND` |
| `createOrder` | `POST /orders` | role: BUYER; body ≤ 4 MiB | `Idempotency-Key`, body `createOrderBody` | 201 `order`, `ETag`, `Location` (a replay: the stored status and body) | `VENDOR_INACTIVE`, `IDEMPOTENCY_KEY_REUSED`; field `VENDOR_NOT_FOUND` |
| `editOrder` | `PATCH /orders/:id` | role: BUYER, `ifMatch`; body ≤ 4 MiB | `idParams`, body `editOrderBody` | 200 `order`, `ETag` | `NOT_FOUND`, `VERSION_CONFLICT`, `VENDOR_INACTIVE`; field `VENDOR_NOT_FOUND`, `LINE_NOT_FOUND`, `DUPLICATE_LINE_ID` |
| `deleteOrder` | `DELETE /orders/:id` | role: BUYER, `ifMatch` | `idParams`, body `deleteOrderBody` (optional) | 204 | `NOT_FOUND`, `VERSION_CONFLICT` |
| `listOrderTimeline` | `GET /orders/:id/timeline` | role: all three | `idParams`, query `pageQuery` | 200 `pageOf(orderTimelineItem)` | `NOT_FOUND` |

Common set as slice 2 (`UNAUTHENTICATED`, `ACCESS_TOKEN_EXPIRED`, `SESSION_*`,
`CSRF_REJECTED` on writes, `NO_ROLE_ASSIGNED`, `FORBIDDEN`, `VALIDATION_FAILED`,
`PAYLOAD_TOO_LARGE`, `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`,
`CONCURRENCY_RETRY_EXHAUSTED`).

Not reachable in this slice and so not documented yet: `ORDER_LOCKED`,
`INVALID_STATE_TRANSITION` on orders, `NOT_ORDER_OWNER` (all need a non-draft order;
slices 4–5 add them to these operations).

`DELETE` with a body: allowed by RFC 9110 and our parser; the optional reason is the
body. A `DELETE` with no body is a delete without a reason.

Sorts: lists `createdAt DESC, id DESC`, or `poNumber DESC` when the `poNumber` filter is
given (research R7, owner decision); timeline `occurredAt DESC, id DESC`.

Body limits: `OperationContract` gains `bodyLimitBytes` (default `BODY_LIMIT_BYTES`);
`createOrder` and `editOrder` declare `ORDER_BODY_LIMIT_BYTES`. Parsing runs after
authentication, CSRF and the role check; refusals before parsing close the connection
without reading the body (research R8).

Admin on an order write: `403 FORBIDDEN` with `detail` =
`ORDER_ADMIN_READ_ONLY_MESSAGE` ("Admins can view orders but not change them.").

## Body-schema inventory additions

`createOrder` (`vendorId` req, `lines` req; line: `description`, `quantity`, `unitPrice`
req), `editOrder` (`vendorId`, `lines` req; line: `id` opt, the rest req), `deleteOrder`
(`reason` opt).

## OpenAPI diff (additive only)

- 3 new paths, 6 operations; schemas `Money`, `Order`, `OrderLine`, `OrderListItem`,
  `CreateOrderBody`, `EditOrderBody`, `DeleteOrderBody`, `PageOfOrderListItem`,
  `PageOfOrderTimelineItem`.
- `ErrorCode` (`x-extensible-enum`) gains `IDEMPOTENCY_KEY_REUSED`; `FieldError.code`
  gains `LINE_NOT_FOUND`, `DUPLICATE_LINE_ID`, `READ_ONLY_FIELD`.
- `createOrder` documents the `Idempotency-Key` header parameter (required).
- No removed or narrowed field: the breaking-change check stays green.
