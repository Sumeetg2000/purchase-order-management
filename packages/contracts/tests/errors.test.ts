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
} from '../src/index.js';

describe('[NFR-API-02] error code registry', () => {
  it('[NFR-API-02] codes are unique and UPPER_SNAKE_CASE', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    for (const code of ERROR_CODES) expect(code).toMatch(/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/);
  });

  it('[NFR-API-02] holds exactly the slice 0 and slice 1 codes with their statuses', () => {
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
      ACCESS_REQUEST_NOT_OPEN: 409,
      ACCOUNT_LOCKED: 423,
      RATE_LIMITED: 429,
    });
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

  it('[NFR-FE-02] the public revoke reasons are exactly password changed, password reset and roles changed', () => {
    expect([...PUBLIC_REVOKE_REASONS]).toEqual([
      'PASSWORD_CHANGED',
      'PASSWORD_RESET',
      'ROLES_CHANGED',
    ]);
  });

  it('[NFR-VAL-01] lists the slice 0 and slice 1 field codes', () => {
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

  it('[NFR-API-02] rejects an unknown code, a missing correlation id and extra fields', () => {
    expect(problemSchema.safeParse({ ...valid, code: 'TEAPOT' }).success).toBe(false);
    const withoutId: Record<string, unknown> = { ...valid };
    delete withoutId['correlationId'];
    expect(problemSchema.safeParse(withoutId).success).toBe(false);
    expect(problemSchema.safeParse({ ...valid, stack: 'at x' }).success).toBe(false);
  });
});
