import { describe, expect, it } from 'vitest';
import {
  AppError,
  ERROR_CODES,
  ERROR_REGISTRY,
  FIELD_CODES,
  problemSchema,
  UnregisteredErrorCodeError,
  type ErrorCode,
} from '../src/index.js';

describe('[NFR-API-02] error code registry', () => {
  it('[NFR-API-02] codes are unique and UPPER_SNAKE_CASE', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    for (const code of ERROR_CODES) expect(code).toMatch(/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/);
  });

  it('[NFR-API-02] holds exactly the slice 0 codes with their statuses', () => {
    const statuses = Object.fromEntries(ERROR_CODES.map((c) => [c, ERROR_REGISTRY[c].status]));
    expect(statuses).toEqual({
      VALIDATION_FAILED: 400,
      CSRF_REJECTED: 403,
      NOT_FOUND: 404,
      PAYLOAD_TOO_LARGE: 413,
      INTERNAL_ERROR: 500,
      SERVICE_UNAVAILABLE: 503,
      CONCURRENCY_RETRY_EXHAUSTED: 503,
    });
  });

  it('[NFR-API-02] never uses status 422', () => {
    for (const code of ERROR_CODES) expect(ERROR_REGISTRY[code].status).not.toBe(422);
  });

  it('[NFR-API-02] only VALIDATION_FAILED carries field details, and every entry has a title', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_REGISTRY[code].title.length).toBeGreaterThan(0);
      expect(ERROR_REGISTRY[code].fieldDetails).toBe(code === 'VALIDATION_FAILED');
    }
  });

  it('[NFR-VAL-01] lists the slice 0 field codes', () => {
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

  it('[NFR-API-02] rejects an unknown code, a missing correlation id and extra fields', () => {
    expect(problemSchema.safeParse({ ...valid, code: 'TEAPOT' }).success).toBe(false);
    const withoutId: Record<string, unknown> = { ...valid };
    delete withoutId['correlationId'];
    expect(problemSchema.safeParse(withoutId).success).toBe(false);
    expect(problemSchema.safeParse({ ...valid, stack: 'at x' }).success).toBe(false);
  });
});
