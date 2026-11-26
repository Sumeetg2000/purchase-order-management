import { AppError, type ErrorCode } from '@po/contracts';
import type { Logger } from 'pino';
import { Prisma } from '../generated/prisma/client.js';

// The only module that inspects database and ORM errors (ADR-0007). The shapes below
// were measured with Prisma 7.10.1, @prisma/adapter-pg 7.10.1 and pg 8.23.1 (research
// R5) and are pinned by tests/integration/db-error-shapes.test.ts.

export class DatabaseUnavailableError extends Error {
  override readonly name = 'DatabaseUnavailableError';
  readonly code: ErrorCode = 'SERVICE_UNAVAILABLE';

  constructor(options?: { cause?: unknown }) {
    super('The database is unavailable or overloaded', options);
  }
}

export class ConcurrencyRetryExhaustedError extends Error {
  override readonly name = 'ConcurrencyRetryExhaustedError';
  readonly code: ErrorCode = 'CONCURRENCY_RETRY_EXHAUSTED';

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

/** A raw query's failure (P2010) carries the violation's kind in the adapter cause. */
const CONSTRAINT_KINDS = new Set(['UniqueConstraintViolation', 'ForeignKeyConstraintViolation']);

/**
 * The constraint a unique (P2002) or foreign-key (P2003) violation names, from the ORM or
 * from a raw query (P2010), or undefined for any other error. For code that turns one
 * specific constraint into a domain error.
 */
export function violatedConstraint(error: unknown): string | undefined {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return undefined;
  const cause = adapterCause(error);
  const isViolation =
    error.code === 'P2002' ||
    error.code === 'P2003' ||
    (error.code === 'P2010' && cause?.kind !== undefined && CONSTRAINT_KINDS.has(cause.kind));
  return isViolation ? cause?.constraint?.index : undefined;
}

const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']);

/** The SQLSTATE a database error carries, from the adapter or the raw driver error. */
export function sqlstateOf(error: unknown): string | undefined {
  if (error instanceof Prisma.PrismaClientKnownRequestError)
    return adapterCause(error)?.originalCode;
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

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

type DbErrorClass = 'unavailable' | 'retryable' | 'other';

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
 * Constraint name → the error a client gets when it is violated, for a constraint whose
 * error needs nothing but its name. One whose error needs a read, like the vendor name key
 * (DUPLICATE_VENDOR_NAME names the holder), is mapped by its service instead.
 */
type ConstraintErrors = Readonly<Record<string, () => AppError>>;

// Our trigger functions raise custom SQLSTATEs in class PO (slice 0 research R6, slice 3
// research R4). Each one means a bug in our code, never a client error: the services check
// everything first. So all of them map to INTERNAL_ERROR, logged with their name and rule.
/** A trigger's SQLSTATE: its name, and the rule it enforces, as logged. */
interface TriggerError {
  name: string;
  rule: string;
}

const TRIGGER_ERRORS: Readonly<Record<string, TriggerError>> = {
  PO001: {
    name: 'ACTOR_CONTEXT_REQUIRED',
    rule: 'no actor context, or an incomplete, inconsistent or stale one',
  },
  PO002: {
    name: 'ACTOR_CONTEXT_MISMATCH',
    rule: 'an explicit audit value contradicts the context',
  },
  PO003: { name: 'AUDIT_IMMUTABLE', rule: 'an UPDATE of an audit entry, by any role' },
  PO004: {
    name: 'AUDIT_RETENTION_ACTIVE',
    rule: 'deleting an audit entry inside its 8-year retention',
  },
  PO005: {
    name: 'DERIVED_VALUE_READ_ONLY',
    rule: "a write of an order's total or open-line count outside recompute_orders",
  },
  PO006: { name: 'ORDER_LINES_LOCKED', rule: "a line change on an order that isn't a draft" },
  PO007: { name: 'ORDER_WITHOUT_LINES', rule: 'an order left without lines at commit' },
  PO008: {
    name: 'ORDER_FIELD_IMMUTABLE',
    rule: "a change of an order's PO number (once set), owner or creation time",
  },
  PO009: {
    name: 'ORDER_STATUS_TRANSITION_REFUSED',
    rule: 'a status change not in order_status_transitions',
  },
  PO010: { name: 'ORDER_DELETE_REFUSED', rule: "a delete of an order that isn't a draft" },
  PO011: { name: 'PO_NUMBER_UNASSIGNED', rule: 'an order committed without a PO number' },
  PO012: {
    name: 'APPROVAL_STEP_REFUSED',
    rule: 'an approval step inserted, moved, changed after its round closed, or deleted (slice 4)',
  },
  PO013: {
    name: 'APPROVAL_ROUND_REFUSED',
    rule: 'an approval round inserted, changed or deleted out of turn; AUTO_APPROVED outside SYSTEM',
  },
  PO014: {
    name: 'ORDER_APPROVAL_INCONSISTENT',
    rule: "at commit: an order's status, round, chain or dates disagree",
  },
  PO015: {
    name: 'ORDER_SUBMISSION_FIELD_LOCKED',
    rule: 'the vendor or a submission column changed outside a status transition',
  },
  PO016: {
    name: 'SELF_DECISION_REFUSED',
    rule: "a step decided by the order's owner, or by someone other than the acting user",
  },
  PO017: {
    name: 'APPROVAL_POLICY_IMMUTABLE',
    rule: 'a policy row changed, or set_approval_policy outside OPERATOR or with invalid tiers',
  },
  PO018: {
    name: 'ORDER_CLOSED',
    rule: 'any change to a rejected or cancelled order: both are final (slice 5, D9)',
  },
  PO019: {
    name: 'ORDER_CANCEL_REFUSED',
    rule: 'the cancel record set outside the cancel, or the cancel changing anything else (D10)',
  },
  // Slice 6: goods receipt (specs/007-goods-receipt/research.md R4, D12-D17).
  PO020: { name: 'ORDER_NOT_RECEIVABLE', rule: 'a receipt on an order that is not APPROVED' },
  PO021: {
    name: 'RECEIPT_NOT_BY_OWNER',
    rule: 'a receipt not recorded by the order owner as the acting user',
  },
  PO022: {
    name: 'RECEIPT_EXCEEDS_ORDERED',
    rule: 'a receipt taking a line above its ordered quantity',
  },
  PO023: {
    name: 'RECEIPT_IMMUTABLE',
    rule: 'a receipt or receipt line changed, or a line added to a receipt by a later statement',
  },
  PO024: {
    name: 'RECEIPT_BEFORE_APPROVAL',
    rule: "a receipt dated before the order's approval date in India time",
  },
  PO025: {
    name: 'RECEIPT_DATE_TOO_LATE',
    rule: "a receipt dated after the database's India date plus one day",
  },
};
const TRIGGER_SQLSTATE = /^PO[0-9A-Z]{3}$/;

interface MapDbErrorOptions {
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
  { logger, constraints = {} }: MapDbErrorOptions,
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

  const constraint = violatedConstraint(error);
  if (constraint !== undefined || error.code === 'P2002' || error.code === 'P2003') {
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
    const known = Object.hasOwn(TRIGGER_ERRORS, sqlstate) ? TRIGGER_ERRORS[sqlstate] : undefined;
    logger.error(
      { err: error, sqlstate, triggerError: known?.name, rule: known?.rule },
      'database trigger refused the change',
    );
    return new AppError('INTERNAL_ERROR', { cause: error });
  }
  logger.error({ err: error, prismaCode: error.code, sqlstate }, 'unmapped database error');
  return new AppError('INTERNAL_ERROR', { cause: error });
}
