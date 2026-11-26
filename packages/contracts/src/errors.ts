import { oneOf } from './one-of.js';
import type { OrderAction, OrderStatus } from './orders.js';

// The single error code registry (ADR-0007). The API, the OpenAPI generator and the web
// app's message map all read it. Each slice adds the codes it uses, never earlier.

export interface ErrorDefinition {
  status: number;
  title: string;
  /** Whether the problem may carry `details[{ path, code }]`. */
  fieldDetails: boolean;
  /** Whether the problem may carry a public revoke `reason` (ADR-0017). */
  revokeReason?: true;
  /** The member naming the existing resource a request clashed with (ADR-0007). */
  clash?: ClashMember;
  /** Whether the problem may carry `orderState`: the order's status, and the action refused. */
  orderState?: true;
  /** Whether the problem may carry `lines`: each line a receipt would over-receive. */
  receiptLines?: true;
}

/** A line a receipt would take above its ordered quantity (ADR-0007, 2026-11-24). */
export interface ExceedingLine {
  lineId: string;
  /** The line's position on the order, from 0; shown as position + 1. */
  position: number;
  outstanding: number;
  requested: number;
}

/** An order state refusal's typed member (ADR-0007, amended 2026-11-17). */
export interface OrderState {
  status: OrderStatus;
  action?: OrderAction;
}

/** One typed member per clash kind (ADR-0007, amended 2026-11-06). */
export const CLASH_MEMBERS = ['existingVendor'] as const;
export type ClashMember = (typeof CLASH_MEMBERS)[number];

export const ERROR_REGISTRY = {
  VALIDATION_FAILED: { status: 400, title: 'Validation failed', fieldDetails: true },
  CSRF_REJECTED: { status: 403, title: 'Request refused', fieldDetails: false },
  NOT_FOUND: { status: 404, title: 'Not found', fieldDetails: false },
  PAYLOAD_TOO_LARGE: { status: 413, title: 'Payload too large', fieldDetails: false },
  INTERNAL_ERROR: { status: 500, title: 'Internal error', fieldDetails: false },
  SERVICE_UNAVAILABLE: { status: 503, title: 'Service unavailable', fieldDetails: false },
  CONCURRENCY_RETRY_EXHAUSTED: {
    status: 503,
    title: 'Too much concurrent activity',
    fieldDetails: false,
  },

  // Slice 1: accounts and sessions (ADR-0007, ADR-0017; contracts/errors.md).
  SIGNUP_DOMAIN_NOT_ALLOWED: {
    status: 400,
    title: 'Email domain not allowed',
    fieldDetails: false,
  },
  TOKEN_EXPIRED: { status: 400, title: 'Link expired', fieldDetails: false },
  TOKEN_USED: { status: 400, title: 'Link already used', fieldDetails: false },
  TOKEN_SUPERSEDED: { status: 400, title: 'Link replaced by a newer one', fieldDetails: false },
  INVALID_TOKEN: { status: 400, title: 'Invalid link', fieldDetails: false },
  UNAUTHENTICATED: { status: 401, title: 'Not logged in', fieldDetails: false },
  ACCESS_TOKEN_EXPIRED: { status: 401, title: 'Access token expired', fieldDetails: false },
  SESSION_EXPIRED: { status: 401, title: 'Session expired', fieldDetails: false },
  SESSION_REVOKED: {
    status: 401,
    title: 'Session revoked',
    fieldDetails: false,
    revokeReason: true,
  },
  PASSWORD_NOT_SET: { status: 401, title: 'No password set', fieldDetails: false },
  INCORRECT_PASSWORD: { status: 401, title: 'Incorrect password', fieldDetails: false },
  ACCOUNT_NOT_VERIFIED: { status: 401, title: 'Email not verified', fieldDetails: false },
  ACCOUNT_DEACTIVATED: { status: 401, title: 'Account deactivated', fieldDetails: false },
  FORBIDDEN: { status: 403, title: 'Forbidden', fieldDetails: false },
  NO_ROLE_ASSIGNED: { status: 403, title: 'No role assigned', fieldDetails: false },
  ACCOUNT_NOT_FOUND: { status: 404, title: 'Account not found', fieldDetails: false },
  EMAIL_IN_USE: { status: 409, title: 'Email already in use', fieldDetails: false },
  ACCOUNT_ALREADY_VERIFIED: {
    status: 409,
    title: 'Account already verified',
    fieldDetails: false,
  },
  VERSION_CONFLICT: { status: 409, title: 'Version conflict', fieldDetails: false },
  SELF_MODIFICATION: { status: 409, title: 'Own account', fieldDetails: false },
  ADMIN_NOT_MODIFIABLE: { status: 409, title: 'Admin account', fieldDetails: false },
  USER_UNVERIFIED: { status: 409, title: 'User not verified', fieldDetails: false },
  USER_DEACTIVATED: { status: 409, title: 'User deactivated', fieldDetails: false },
  ACCESS_REQUEST_NOT_OPEN: {
    status: 409,
    title: 'Access request not open',
    fieldDetails: false,
  },
  ACCOUNT_LOCKED: { status: 423, title: 'Account locked', fieldDetails: false },
  RATE_LIMITED: { status: 429, title: 'Too many requests', fieldDetails: false },

  // Slice 2: vendors (specs/003-vendors/contracts/errors.md).
  DUPLICATE_VENDOR_NAME: {
    status: 409,
    title: 'Vendor name already used',
    fieldDetails: false,
    clash: 'existingVendor',
  },
  INVALID_STATE_TRANSITION: {
    status: 409,
    title: 'Invalid state transition',
    fieldDetails: false,
    // Orders name their status and the refused action; vendors carry none.
    orderState: true,
  },
  // First route: order create, slice 3.
  VENDOR_INACTIVE: { status: 409, title: 'Vendor deactivated', fieldDetails: false },

  // Slice 3: draft orders (specs/004-draft-orders/contracts/errors.md).
  IDEMPOTENCY_KEY_REUSED: {
    status: 409,
    title: 'Idempotency key already used',
    fieldDetails: false,
  },

  // Slice 4: submission and decisions (specs/005-submit-approve/contracts/errors.md). The
  // problem details are constants in approvals.ts.
  NOT_ORDER_OWNER: { status: 403, title: 'Not the order owner', fieldDetails: false },
  SELF_APPROVAL: { status: 403, title: 'Own order', fieldDetails: false },
  ORDER_LOCKED: { status: 409, title: 'Order locked', fieldDetails: false, orderState: true },
  ORDER_PENDING_APPROVAL: {
    status: 409,
    title: 'Order waiting for approval',
    fieldDetails: false,
    orderState: true,
  },
  ORDER_OWNER_INACTIVE: {
    status: 409,
    title: 'Order owner can no longer act',
    fieldDetails: false,
  },

  // Slice 6: goods receipt (specs/007-goods-receipt/contracts/errors.md).
  ORDER_NOT_RECEIVABLE: {
    status: 409,
    title: 'Order not receivable',
    fieldDetails: false,
    orderState: true,
  },
  RECEIPT_EXCEEDS_OUTSTANDING: {
    status: 409,
    title: 'Receipt exceeds outstanding',
    fieldDetails: false,
    receiptLines: true,
  },
  ORDER_FULLY_RECEIVED: { status: 409, title: 'Order fully received', fieldDetails: false },
} as const satisfies Record<string, ErrorDefinition>;

export type ErrorCode = keyof typeof ERROR_REGISTRY;

export const ERROR_CODES = Object.keys(ERROR_REGISTRY) as readonly ErrorCode[];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_REGISTRY, value);
}

/** Whether a code's problem may name the order's status and the refused action. */
export function carriesOrderState(code: ErrorCode): boolean {
  const entry: ErrorDefinition = ERROR_REGISTRY[code];
  return entry.orderState === true;
}

export function isFieldCode(value: unknown): value is FieldCode {
  return oneOf(FIELD_CODES, value);
}

/** Whether a code's problem may list the lines a receipt would over-receive. */
export function carriesReceiptLines(code: ErrorCode): boolean {
  const entry: ErrorDefinition = ERROR_REGISTRY[code];
  return entry.receiptLines === true;
}

/** Whether a problem with this code may carry a public revoke `reason`. */
export function carriesRevokeReason(code: ErrorCode): boolean {
  const entry: ErrorDefinition = ERROR_REGISTRY[code];
  return entry.revokeReason === true;
}

/** The clash member a problem with this code may carry, if any. */
export function clashMemberOf(code: ErrorCode): ClashMember | undefined {
  const entry: ErrorDefinition = ERROR_REGISTRY[code];
  return entry.clash;
}

/** Codes inside `details[]` of `VALIDATION_FAILED`. */
export const FIELD_CODES = [
  'MALFORMED_JSON',
  'UNSUPPORTED_MEDIA_TYPE',
  'REQUIRED',
  'UNKNOWN_FIELD',
  'INVALID_FORMAT',
  'TOO_SHORT',
  'TOO_LONG',
  'OUT_OF_RANGE',
  // Slice 1 (contracts/errors.md)
  'VERSION_REQUIRED',
  'INVALID_ROLE_SET',
  'PASSWORD_TOO_SHORT',
  'PASSWORD_TOO_LONG',
  'PASSWORD_TOO_COMMON',
  'INCORRECT_PASSWORD',
  'PASSWORD_UNCHANGED',
  // Slice 2 (specs/003-vendors/contracts/errors.md)
  'VENDOR_NOT_FOUND',
  // Slice 3 (specs/004-draft-orders/contracts/errors.md)
  'LINE_NOT_FOUND',
  'DUPLICATE_LINE_ID',
  'READ_ONLY_FIELD',
  // Slice 6 (specs/007-goods-receipt/contracts/errors.md): the receipt date.
  'DATE_IN_FUTURE',
  'DATE_BEFORE_APPROVAL',
] as const;

export type FieldCode = (typeof FIELD_CODES)[number];

export interface FieldError {
  /** Dot path into the request, e.g. `body.lines.3.quantity` or `header.content-type`. */
  path: string;
  code: FieldCode;
}
