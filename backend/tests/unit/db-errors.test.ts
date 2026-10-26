import { AppError } from '@po/contracts';
import { describe, expect, it } from 'vitest';
import {
  ConcurrencyRetryExhaustedError,
  DatabaseUnavailableError,
  mapDbError,
} from '../../src/db/errors.js';
import { Prisma } from '../../src/generated/prisma/client.js';
import { createCapture } from '../support/log-capture.js';

// Error shapes as measured with Prisma 7.10.1 + @prisma/adapter-pg (research R5).
function known(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError('driver message', {
    code,
    clientVersion: '7.10.1',
    ...(meta ? { meta } : {}),
  });
}

function adapterError(cause: Record<string, unknown>, code = 'P2010') {
  return known(code, { driverAdapterError: { cause } });
}

function map(error: unknown, constraints = {}) {
  const { logger, lines } = createCapture();
  return { result: mapDbError(error, { logger, constraints }), lines };
}

describe('[NFR-API-02] central database error mapper', () => {
  it('[NFR-API-02] maps P2002 by cause.constraint.index through the constraint table', () => {
    const error = adapterError(
      { kind: 'UniqueConstraintViolation', constraint: { index: 'items_name_key' } },
      'P2002',
    );
    const constraints = {
      items_name_key: () =>
        new AppError('VALIDATION_FAILED', {
          details: [{ path: 'body.name', code: 'INVALID_FORMAT' }],
        }),
    };
    const { result } = map(error, constraints);
    expect(result?.code).toBe('VALIDATION_FAILED');
    expect(result?.details).toEqual([{ path: 'body.name', code: 'INVALID_FORMAT' }]);
  });

  it('[NFR-API-02] an unknown constraint is INTERNAL_ERROR and logged', () => {
    const error = adapterError(
      { kind: 'UniqueConstraintViolation', constraint: { index: 'unexpected_key' } },
      'P2002',
    );
    const { result, lines } = map(error);
    expect(result?.code).toBe('INTERNAL_ERROR');
    expect(lines.some((l) => l['level'] === 50 && l['constraint'] === 'unexpected_key')).toBe(true);
  });

  it('[NFR-API-02] maps P2003 by constraint too, defaulting to INTERNAL_ERROR', () => {
    const error = adapterError(
      { kind: 'ForeignKeyConstraintViolation', constraint: { index: 'items_vendor_fkey' } },
      'P2003',
    );
    expect(map(error).result?.code).toBe('INTERNAL_ERROR');
    expect(map(error, { items_vendor_fkey: () => new AppError('NOT_FOUND') }).result?.code).toBe(
      'NOT_FOUND',
    );
  });

  it('[NFR-API-02] P2025 (record not found) is NOT_FOUND', () => {
    expect(map(known('P2025')).result?.code).toBe('NOT_FOUND');
  });

  it('[NFR-CON-02] P2028, the pg-pool timeout and an unreachable database are SERVICE_UNAVAILABLE', () => {
    const poolTimeout = new Error('timeout exceeded when trying to connect');
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
      code: 'ECONNREFUSED',
    });
    for (const error of [
      known('P2028'),
      poolTimeout,
      refused,
      adapterError({ kind: 'DatabaseNotReachable' }),
      new DatabaseUnavailableError(),
    ]) {
      expect(map(error).result?.code).toBe('SERVICE_UNAVAILABLE');
    }
  });

  it('[NFR-CON-02] a dropped, timed-out or refused connection and a shutting-down server are SERVICE_UNAVAILABLE', () => {
    for (const cause of [
      { kind: 'ConnectionClosed' },
      { kind: 'SocketTimeout' },
      { kind: 'TooManyConnections', originalCode: '53300' },
      { kind: 'postgres', originalCode: '57P01' },
      { kind: 'postgres', originalCode: '57P03' },
      { kind: 'postgres', originalCode: '08006' },
    ]) {
      expect(map(adapterError(cause)).result?.code, JSON.stringify(cause)).toBe(
        'SERVICE_UNAVAILABLE',
      );
    }
  });

  it('[NFR-CON-02] a write conflict outside the retry loop, or retries exhausted, is CONCURRENCY_RETRY_EXHAUSTED', () => {
    for (const error of [
      adapterError({ kind: 'TransactionWriteConflict', originalCode: '40001' }),
      new ConcurrencyRetryExhaustedError(4),
    ]) {
      expect(map(error).result?.code).toBe('CONCURRENCY_RETRY_EXHAUSTED');
    }
  });

  it.each(['PO001', 'PO002'])(
    '[NFR-API-02] trigger SQLSTATE %s is INTERNAL_ERROR, logged as a bug',
    (sqlstate) => {
      const { result, lines } = map(adapterError({ kind: 'postgres', originalCode: sqlstate }));
      expect(result?.code).toBe('INTERNAL_ERROR');
      expect(lines.some((l) => l['level'] === 50 && l['sqlstate'] === sqlstate)).toBe(true);
    },
  );

  it('[NFR-API-02] returns undefined for errors that are not from the database', () => {
    expect(map(new Error('something else')).result).toBeUndefined();
    expect(map(new AppError('NOT_FOUND')).result).toBeUndefined();
  });
});
