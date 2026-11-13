// Order constants (ADR-0001, ADR-0003, ADR-0007; specs/004-draft-orders/data-model.md). The
// order tables' CHECKs (migration 0013_orders) hold SQL copies of these, and nginx holds
// the body limit; backend tests pin each copy (order-constants, nginx-limits).

export const ORDER_LINES_MIN = 1;
export const ORDER_LINES_MAX = 500;
/** In Unicode code points, not UTF-16 units (research R9). */
export const LINE_DESCRIPTION_MAX = 500;
export const LINE_QUANTITY_MAX = 1_000_000;
/** The largest numeric(13,4). */
export const UNIT_PRICE_MAX = '999999999.9999';
/** In Unicode code points. */
export const DELETE_REASON_MAX = 500;

export const ORDER_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** `PO-{FY}-{seq}`: the financial year and a sequence of at least 6 digits. */
export const PO_NUMBER_PATTERN = /^PO-\d{4}-\d{2}-\d{6,}$/;
/** The time zone that decides an order's financial year. */
export const PO_NUMBER_TIME_ZONE = 'Asia/Kolkata';

/**
 * The request limit of order create and edit: fits the largest valid order (500 lines of
 * 500 four-byte characters) even with every character escaped (research R8).
 */
export const ORDER_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

/** How long a create's Idempotency-Key is remembered (research R5). */
export const IDEMPOTENCY_KEY_TTL_HOURS = 24;

/** The detail of an Admin's 403 on an order write (ADR-0004, 2026-11-12). */
export const ORDER_ADMIN_READ_ONLY_MESSAGE = 'Admins can view orders but not change them.';

/** Derived or system-assigned: refused in any order body with READ_ONLY_FIELD (ADR-0003). */
export const ORDER_READ_ONLY_FIELDS = [
  'total',
  'lineTotal',
  'receivedQuantity',
  'outstandingQuantity',
  'openLineCount',
  'poNumber',
  'position',
  'version',
  'status',
  'owner',
  'ownerId',
  'createdAt',
  'updatedAt',
  'lineCount',
] as const;
