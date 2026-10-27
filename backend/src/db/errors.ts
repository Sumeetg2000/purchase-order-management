import { AppError } from '@po/contracts';
import type { Logger } from 'pino';
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
  /** Unique and foreign-key violations name the constraint here (research R5). */
  constraint?: { index?: string };
}

function adapterCause(error: Prisma.PrismaClientKnownRequestError): DriverAdapterCause | undefined {
  const meta = error.meta as { driverAdapterError?: { cause?: DriverAdapterCause } } | undefined;
  return meta?.driverAdapterError?.cause;
}

const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']);

// adapter-pg kinds for a connection that can't be made or was lost (it maps ECONNREFUSED
// and ENOTFOUND, ECONNRESET, ETIMEDOUT and SQLSTATE 53300 to these).
const UNAVAILABLE_KINDS = new Set([
  'DatabaseNotReachable',
  'ConnectionClosed',
  'SocketTimeout',
  'TooManyConnections',
]);

// Connection exceptions (class 08), too many connections (53300), and a server shutting
// down or starting up (57P01-57P03) arrive with the raw SQLSTATE.
// A lock that couldn't be taken within lock_timeout (55P03) is the same for the caller: the
// database can't serve the request now.
const UNAVAILABLE_SQLSTATE = /^(08...|53300|55P03|57P0[123])$/;

// Node socket error codes for a database that can't be reached. The adapter usually wraps
// them as P2010 DatabaseNotReachable, but on some hosts (the CI runner) the raw pg
// connect error arrives unwrapped with one of these codes (research R5).
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

// Matched by code whatever the error's class: the raw pg error and a Prisma error that
// carries the Node code have both been observed.
function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === 'string' && CONNECTION_ERROR_CODES.has(code);
}

export type DbErrorClass = 'unavailable' | 'retryable' | 'other';

/** Classifies an error for the transaction helper: give up with 503, retry, or rethrow. */
export function classifyDbError(error: unknown): DbErrorClass {
  if (isPoolTimeout(error) || isConnectionError(error)) return 'unavailable';
  if (error instanceof Prisma.PrismaClientInitializationError) return 'unavailable';
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2028') return 'unavailable';
    if (error.code === 'P2034') return 'retryable';
    const cause = adapterCause(error);
    if (cause?.kind !== undefined && UNAVAILABLE_KINDS.has(cause.kind)) return 'unavailable';
    if (cause?.originalCode !== undefined && UNAVAILABLE_SQLSTATE.test(cause.originalCode)) {
      return 'unavailable';
    }
    if (
      cause?.kind === 'TransactionWriteConflict' ||
      (cause?.originalCode !== undefined && RETRYABLE_SQLSTATES.has(cause.originalCode))
    ) {
      return 'retryable';
    }
  }
  return 'other';
}

/**
 * Constraint name → the error a client gets when it is violated. Each slice adds the
 * constraints its business rules rely on (for example a duplicate vendor name).
 */
export type ConstraintErrors = Readonly<Record<string, () => AppError>>;

export const CONSTRAINT_ERRORS: ConstraintErrors = {};

// Our trigger functions raise custom SQLSTATEs in class PO (research R6). Each one means a
// bug in our code, never a client error, so all of them map to INTERNAL_ERROR:
//   PO001 ACTOR_CONTEXT_REQUIRED  no actor context, or an incomplete, inconsistent or
//                                 stale one (not bound to the current transaction)
//   PO002 ACTOR_CONTEXT_MISMATCH  an explicit audit value contradicts the context
//   PO003 AUDIT_IMMUTABLE         an UPDATE of an audit entry, by any role
//   PO004 AUDIT_RETENTION_ACTIVE  deleting an audit entry inside its 8-year retention
const TRIGGER_SQLSTATE = /^PO[0-9A-Z]{3}$/;

export interface MapDbErrorOptions {
  logger: Logger;
  constraints?: ConstraintErrors;
}

/**
 * The one translation from database and ORM errors to registry codes (ADR-0007).
 * Returns undefined for anything that is not a database error. Unexpected database
 * errors become INTERNAL_ERROR and are logged here with what identifies them.
 */
export function mapDbError(
  error: unknown,
  { logger, constraints = CONSTRAINT_ERRORS }: MapDbErrorOptions,
): AppError | undefined {
  if (error instanceof DatabaseUnavailableError) {
    logger.warn({ err: error }, 'database unavailable');
    return new AppError('SERVICE_UNAVAILABLE', { cause: error });
  }
  if (error instanceof ConcurrencyRetryExhaustedError) {
    logger.warn({ err: error, attempts: error.attempts }, 'concurrency retries exhausted');
    return new AppError('CONCURRENCY_RETRY_EXHAUSTED', { cause: error });
  }

  const kind = classifyDbError(error);
  if (kind === 'unavailable') {
    logger.warn({ err: error }, 'database unavailable');
    return new AppError('SERVICE_UNAVAILABLE', { cause: error });
  }
  if (kind === 'retryable') {
    // A conflict outside withTransaction's retry loop is reported like exhausted retries.
    logger.warn({ err: error }, 'database write conflict');
    return new AppError('CONCURRENCY_RETRY_EXHAUSTED', { cause: error });
  }

  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return undefined;
  const cause = adapterCause(error);

  if (error.code === 'P2002' || error.code === 'P2003') {
    const constraint = cause?.constraint?.index;
    const toError =
      constraint !== undefined && Object.hasOwn(constraints, constraint)
        ? constraints[constraint]
        : undefined;
    if (toError) return toError();
    logger.error(
      { err: error, prismaCode: error.code, constraint },
      'unmapped constraint violation',
    );
    return new AppError('INTERNAL_ERROR', { cause: error });
  }
  if (error.code === 'P2025') return new AppError('NOT_FOUND', { cause: error });

  const sqlstate = cause?.originalCode;
  if (sqlstate !== undefined && TRIGGER_SQLSTATE.test(sqlstate)) {
    // A code path forgot its actor context or contradicted it: a bug, never a client error.
    logger.error({ err: error, sqlstate }, 'database trigger refused the change');
    return new AppError('INTERNAL_ERROR', { cause: error });
  }
  logger.error({ err: error, prismaCode: error.code, sqlstate }, 'unmapped database error');
  return new AppError('INTERNAL_ERROR', { cause: error });
}
