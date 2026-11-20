import { describe, expect, it } from 'vitest';
import {
  AppError,
  ERROR_CODES,
  ERROR_REGISTRY,
  FIELD_CODES,
  problemSchema,
  PUBLIC_REVOKE_REASONS,
  UnregisteredErrorCodeError,
  type ErrorCode,
  type ErrorDefinition,
  NOT_ORDER_OWNER_DETAIL,
  ORDER_LOCKED_MESSAGES,
  ORDER_OWNER_INACTIVE_DETAIL,
  ORDER_PENDING_APPROVAL_DETAIL,
  SELF_APPROVAL_DETAIL,
  carriesOrderState,
} from '../src/index.js';

describe('[NFR-API-02] error code registry', () => {
  it('[NFR-API-02] codes are unique and UPPER_SNAKE_CASE', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    for (const code of ERROR_CODES) expect(code).toMatch(/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/);
  });

  it('[NFR-API-02] holds exactly the slice 0 to slice 4 codes with their statuses', () => {
    const statuses = Object.fromEntries(ERROR_CODES.map((c) => [c, ERROR_REGISTRY[c].status]));
    expect(statuses).toEqual({
      VALIDATION_FAILED: 400,
      CSRF_REJECTED: 403,
      NOT_FOUND: 404,
      PAYLOAD_TOO_LARGE: 413,
      INTERNAL_ERROR: 500,
      SERVICE_UNAVAILABLE: 503,
      CONCURRENCY_RETRY_EXHAUSTED: 503,
      // Slice 1 (contracts/errors.md)
      SIGNUP_DOMAIN_NOT_ALLOWED: 400,
      TOKEN_EXPIRED: 400,
      TOKEN_USED: 400,
      TOKEN_SUPERSEDED: 400,
      INVALID_TOKEN: 400,
      UNAUTHENTICATED: 401,
      ACCESS_TOKEN_EXPIRED: 401,
      SESSION_EXPIRED: 401,
      SESSION_REVOKED: 401,
      PASSWORD_NOT_SET: 401,
      INCORRECT_PASSWORD: 401,
      ACCOUNT_NOT_VERIFIED: 401,
      ACCOUNT_DEACTIVATED: 401,
      FORBIDDEN: 403,
      NO_ROLE_ASSIGNED: 403,
      ACCOUNT_NOT_FOUND: 404,
      EMAIL_IN_USE: 409,
      ACCOUNT_ALREADY_VERIFIED: 409,
      VERSION_CONFLICT: 409,
      SELF_MODIFICATION: 409,
      ADMIN_NOT_MODIFIABLE: 409,
      USER_UNVERIFIED: 409,
      USER_DEACTIVATED: 409,
      ACCESS_REQUEST_NOT_OPEN: 409,
      ACCOUNT_LOCKED: 423,
      RATE_LIMITED: 429,
      // Slice 2 (specs/003-vendors/contracts/errors.md)
      DUPLICATE_VENDOR_NAME: 409,
      INVALID_STATE_TRANSITION: 409,
      VENDOR_INACTIVE: 409,
      // Slice 3 (specs/004-draft-orders/contracts/errors.md)
      IDEMPOTENCY_KEY_REUSED: 409,
      // Slice 4 (specs/005-submit-approve/contracts/errors.md)
      NOT_ORDER_OWNER: 403,
      SELF_APPROVAL: 403,
      ORDER_LOCKED: 409,
      ORDER_PENDING_APPROVAL: 409,
      ORDER_OWNER_INACTIVE: 409,
    });
  });

  it('[FR-SOD-01] has no DUPLICATE_APPROVER: the rule was removed (ADR-0002)', () => {
    expect(ERROR_CODES).not.toContain('DUPLICATE_APPROVER');
  });

  it('[FR-LCK-01] the slice 4 problem details are the owner-approved sentences', () => {
    expect(ORDER_PENDING_APPROVAL_DETAIL).toBe(
      'This order is waiting for approval. Withdraw it to make changes.',
    );
    expect(ORDER_OWNER_INACTIVE_DETAIL).toBe(
      'The buyer who raised this order can no longer act on it. Reject it, or approve once their access is restored.',
    );
    expect(ORDER_LOCKED_MESSAGES).toEqual({
      APPROVED: 'This order is approved and locked.',
      REJECTED: 'This order was rejected and is closed. Raise a new order instead.',
    });
    expect(NOT_ORDER_OWNER_DETAIL).toBe('Only the buyer who raised this order can do that.');
    expect(SELF_APPROVAL_DETAIL).toBe("You can't approve or reject an order you raised.");
  });

  it('[NFR-API-02] never uses status 422', () => {
    for (const code of ERROR_CODES) expect(ERROR_REGISTRY[code].status).not.toBe(422);
  });

  it('[NFR-API-02] only VALIDATION_FAILED carries field details, only SESSION_REVOKED a reason, and every entry has a title', () => {
    for (const code of ERROR_CODES) {
      const entry: ErrorDefinition = ERROR_REGISTRY[code];
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.fieldDetails).toBe(code === 'VALIDATION_FAILED');
      expect(entry.revokeReason ?? false).toBe(code === 'SESSION_REVOKED');
    }
  });

  it('[FR-VEN-01] only DUPLICATE_VENDOR_NAME names a clash member, existingVendor', () => {
    for (const code of ERROR_CODES) {
      const entry: ErrorDefinition = ERROR_REGISTRY[code];
      expect(entry.clash, code).toBe(
        code === 'DUPLICATE_VENDOR_NAME' ? 'existingVendor' : undefined,
      );
    }
  });

  it('[NFR-FE-02] the public revoke reasons are exactly password changed, password reset and roles changed', () => {
    expect([...PUBLIC_REVOKE_REASONS]).toEqual([
      'PASSWORD_CHANGED',
      'PASSWORD_RESET',
      'ROLES_CHANGED',
    ]);
  });

  it('[NFR-VAL-01] lists the slice 0 to slice 3 field codes', () => {
    expect([...FIELD_CODES].sort()).toEqual(
      [
        'MALFORMED_JSON',
        'UNSUPPORTED_MEDIA_TYPE',
        'REQUIRED',
        'UNKNOWN_FIELD',
        'INVALID_FORMAT',
        'TOO_SHORT',
        'TOO_LONG',
        'OUT_OF_RANGE',
        'VERSION_REQUIRED',
        'INVALID_ROLE_SET',
        'PASSWORD_TOO_SHORT',
        'PASSWORD_TOO_LONG',
        'PASSWORD_TOO_COMMON',
        'INCORRECT_PASSWORD',
        'PASSWORD_UNCHANGED',
        'VENDOR_NOT_FOUND',
        'LINE_NOT_FOUND',
        'DUPLICATE_LINE_ID',
        'READ_ONLY_FIELD',
      ].sort(),
    );
  });
});

describe('[NFR-API-02] AppError', () => {
  it('[NFR-API-02] takes its status from the registry and keeps field details', () => {
    const error = new AppError('VALIDATION_FAILED', {
      details: [{ path: 'body.name', code: 'REQUIRED' }],
    });
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.status).toBe(400);
    expect(error.details).toEqual([{ path: 'body.name', code: 'REQUIRED' }]);
  });

  it('[NFR-FE-02] carries a public revoke reason on SESSION_REVOKED only', () => {
    expect(new AppError('SESSION_REVOKED', { reason: 'ROLES_CHANGED' }).reason).toBe(
      'ROLES_CHANGED',
    );
    expect(new AppError('SESSION_REVOKED').reason).toBeUndefined();
    expect(() => new AppError('SESSION_EXPIRED', { reason: 'ROLES_CHANGED' })).toThrow(TypeError);
  });

  it('[FR-VEN-01] carries existingVendor on DUPLICATE_VENDOR_NAME only', () => {
    const existingVendor = { id: '0192e4a0-7b1c-7cc0-8a4e-1f2b3c4d5e6f', name: 'Acme Supplies' };
    expect(new AppError('DUPLICATE_VENDOR_NAME', { existingVendor }).existingVendor).toEqual(
      existingVendor,
    );
    expect(new AppError('DUPLICATE_VENDOR_NAME').existingVendor).toBeUndefined();
    expect(() => new AppError('VERSION_CONFLICT', { existingVendor })).toThrow(TypeError);
  });

  it('[FR-SM-01] carries orderState on the order state codes only', () => {
    const orderState = { status: 'APPROVED', action: 'EDIT' } as const;
    expect(new AppError('ORDER_LOCKED', { orderState }).orderState).toEqual(orderState);
    expect(new AppError('ORDER_PENDING_APPROVAL', { orderState }).orderState).toEqual(orderState);
    expect(new AppError('INVALID_STATE_TRANSITION', { orderState }).orderState).toEqual(orderState);
    expect(() => new AppError('VERSION_CONFLICT', { orderState })).toThrow(TypeError);
    for (const code of ERROR_CODES) {
      expect(carriesOrderState(code), code).toBe(
        ['ORDER_LOCKED', 'ORDER_PENDING_APPROVAL', 'INVALID_STATE_TRANSITION'].includes(code),
      );
    }
  });

  it('[NFR-API-02] refuses an unregistered code at compile time and at run time', () => {
    // @ts-expect-error: not a registered code
    expect(() => new AppError('NOT_A_CODE')).toThrow(UnregisteredErrorCodeError);
    expect(() => new AppError('ALSO_NOT' as ErrorCode)).toThrow(UnregisteredErrorCodeError);
  });
});

describe('[NFR-API-02] problem schema', () => {
  const valid = {
    type: 'about:blank',
    title: 'Not found',
    status: 404,
    code: 'NOT_FOUND',
    correlationId: 'req-12345678',
  };

  it('[NFR-API-02] accepts a registered code with a correlation id', () => {
    expect(problemSchema.safeParse(valid).success).toBe(true);
    expect(
      problemSchema.safeParse({
        ...valid,
        code: 'VALIDATION_FAILED',
        status: 400,
        details: [{ path: 'body', code: 'MALFORMED_JSON' }],
      }).success,
    ).toBe(true);
  });

  it('[FR-SM-01] accepts orderState on the order state codes, and nowhere else', () => {
    const locked = { ...valid, code: 'ORDER_LOCKED', status: 409, title: 'Order locked' };
    expect(problemSchema.safeParse({ ...locked, orderState: { status: 'REJECTED' } }).success).toBe(
      true,
    );
    expect(
      problemSchema.safeParse({ ...locked, orderState: { status: 'REJECTED', action: 'EDIT' } })
        .success,
    ).toBe(true);
    expect(problemSchema.safeParse({ ...locked, orderState: { status: 'LOST' } }).success).toBe(
      false,
    );
    const refused = {
      ...valid,
      code: 'INVALID_STATE_TRANSITION',
      status: 409,
      title: 'Invalid state transition',
    };
    expect(
      problemSchema.safeParse({
        ...refused,
        orderState: { status: 'PENDING_APPROVAL', action: 'CANCEL' },
      }).success,
    ).toBe(true);
    expect(problemSchema.safeParse({ ...valid, orderState: { status: 'DRAFT' } }).success).toBe(
      false,
    );
  });

  it('[NFR-FE-02] accepts a public reason on SESSION_REVOKED, and no reason anywhere else', () => {
    const revoked = { ...valid, code: 'SESSION_REVOKED', status: 401, title: 'Session revoked' };
    expect(problemSchema.safeParse(revoked).success).toBe(true);
    expect(problemSchema.safeParse({ ...revoked, reason: 'PASSWORD_RESET' }).success).toBe(true);
    // Internal reasons never leave the API (ADR-0017, amended 2026-11-03).
    for (const reason of [
      'LOGOUT',
      'LOGOUT_ALL',
      'USER_REVOKED',
      'REUSE_DETECTED',
      'DEACTIVATED',
    ]) {
      expect(problemSchema.safeParse({ ...revoked, reason }).success, reason).toBe(false);
    }
    expect(problemSchema.safeParse({ ...valid, reason: 'PASSWORD_RESET' }).success).toBe(false);
  });

  it('[FR-VEN-01] accepts existingVendor { id, name } on DUPLICATE_VENDOR_NAME only', () => {
    const duplicate = {
      ...valid,
      code: 'DUPLICATE_VENDOR_NAME',
      status: 409,
      title: 'Vendor name already used',
    };
    const existingVendor = { id: '0192e4a0-7b1c-7cc0-8a4e-1f2b3c4d5e6f', name: 'Acme Supplies' };
    expect(problemSchema.safeParse(duplicate).success).toBe(true);
    expect(problemSchema.safeParse({ ...duplicate, existingVendor }).success).toBe(true);
    expect(problemSchema.safeParse({ ...valid, existingVendor }).success).toBe(false);
    expect(
      problemSchema.safeParse({ ...duplicate, existingVendor: { ...existingVendor, id: 'x' } })
        .success,
    ).toBe(false);
    expect(
      problemSchema.safeParse({ ...duplicate, existingVendor: { ...existingVendor, extra: 1 } })
        .success,
    ).toBe(false);
  });

  it('[NFR-API-02] rejects an unknown code, a missing correlation id and extra fields', () => {
    expect(problemSchema.safeParse({ ...valid, code: 'TEAPOT' }).success).toBe(false);
    const withoutId: Record<string, unknown> = { ...valid };
    delete withoutId['correlationId'];
    expect(problemSchema.safeParse(withoutId).success).toBe(false);
    expect(problemSchema.safeParse({ ...valid, stack: 'at x' }).success).toBe(false);
  });
});
