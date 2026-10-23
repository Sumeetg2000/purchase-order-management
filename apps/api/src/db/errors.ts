import { Prisma } from '../generated/prisma/client.js';

// The only module that inspects database and ORM errors (ADR-0007). The shapes below
// were measured with Prisma 7.10.1, @prisma/adapter-pg 7.10.1 and pg 8.23.1 (research
// R5) and are pinned by tests/integration/db-error-shapes.test.ts.

export class DatabaseUnavailableError extends Error {
  override readonly name = 'DatabaseUnavailableError';
  readonly code = 'SERVICE_UNAVAILABLE';

  constructor(options?: { cause?: unknown }) {
    super('The database is unavailable or overloaded', options);
  }
}

export class ConcurrencyRetryExhaustedError extends Error {
  override readonly name = 'ConcurrencyRetryExhaustedError';
  readonly code = 'CONCURRENCY_RETRY_EXHAUSTED';

  constructor(
    readonly attempts: number,
    options?: { cause?: unknown },
  ) {
    super(`Serialization conflict persisted after ${String(attempts)} attempts`, options);
  }
}

// pg-pool's connection-timeout error has no code, only this message. This is the single
// message match allowed in the codebase (ADR-0007); the regression test fails if a pg
// upgrade changes it.
const PG_POOL_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';

export function isPoolTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    !(error instanceof Prisma.PrismaClientKnownRequestError) &&
    error.message === PG_POOL_TIMEOUT_MESSAGE
  );
}

interface DriverAdapterCause {
  kind?: string;
  originalCode?: string;
}

function adapterCause(error: Prisma.PrismaClientKnownRequestError): DriverAdapterCause | undefined {
  const meta = error.meta as { driverAdapterError?: { cause?: DriverAdapterCause } } | undefined;
  return meta?.driverAdapterError?.cause;
}

const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']);

export type DbErrorClass = 'unavailable' | 'retryable' | 'other';

/** Classifies an error for the transaction helper: give up with 503, retry, or rethrow. */
export function classifyDbError(error: unknown): DbErrorClass {
  if (isPoolTimeout(error)) return 'unavailable';
  if (error instanceof Prisma.PrismaClientInitializationError) return 'unavailable';
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2028') return 'unavailable';
    if (error.code === 'P2034') return 'retryable';
    const cause = adapterCause(error);
    if (cause?.kind === 'DatabaseNotReachable') return 'unavailable';
    if (
      cause?.kind === 'TransactionWriteConflict' ||
      (cause?.originalCode !== undefined && RETRYABLE_SQLSTATES.has(cause.originalCode))
    ) {
      return 'retryable';
    }
  }
  return 'other';
}
