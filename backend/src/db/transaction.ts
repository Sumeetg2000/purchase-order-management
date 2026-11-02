import type { Logger } from 'pino';
import type { Prisma } from '../generated/prisma/client.js';
import { createLogger } from '../observability/logger.js';
import type { AppPrismaClient } from './client.js';
import {
  classifyDbError,
  ConcurrencyRetryExhaustedError,
  DatabaseUnavailableError,
} from './errors.js';

/** Who is acting (ADR-0016). Written to transaction-local settings for the triggers. */
export type ActorContext =
  | { type: 'USER'; userId: string; name: string; email: string; actingRole: string }
  | { type: 'SYSTEM' }
  | { type: 'OPERATOR'; osUser: string; host: string };

export interface TransactionOptions {
  prisma: AppPrismaClient;
  actor: ActorContext;
  requestId: string;
  timeoutMs: number;
  maxWaitMs: number;
  retry?: { retries: number; baseDelayMs: number };
  logger?: Logger;
}

export type TransactionClient = Prisma.TransactionClient;

declare const actorContextSet: unique symbol;

/**
 * A transaction whose actor context has been set. Only withTransaction hands one out, so
 * code that needs the context (writeAudit) can't be given a plain prisma.$transaction.
 */
export type AuditedTransaction = TransactionClient & { readonly [actorContextSet]: true };

export interface TransactionHooks {
  /** Runs only after the transaction commits; failures are logged, never thrown. */
  afterCommit: (callback: () => void | Promise<void>) => void;
}

const DEFAULT_RETRY = { retries: 3, baseDelayMs: 20 };
let defaultLogger: Logger | undefined;

async function setActorContext(tx: TransactionClient, actor: ActorContext, requestId: string) {
  const user = actor.type === 'USER' ? actor : undefined;
  const operator = actor.type === 'OPERATOR' ? actor : undefined;
  // set_config(..., true) is transaction-local: gone at commit or rollback, so a pooled
  // connection never carries one request's actor into the next (research R6). actor_txid
  // binds the context to this transaction; the triggers refuse a context bound to no
  // transaction or another one, such as a stray session-level SET.
  await tx.$executeRaw`
    SELECT set_config('app.actor_txid', txid_current()::text, true),
           set_config('app.actor_type', ${actor.type}, true),
           set_config('app.actor_user_id', ${user?.userId ?? ''}, true),
           set_config('app.actor_name', ${user?.name ?? ''}, true),
           set_config('app.actor_email', ${user?.email ?? ''}, true),
           set_config('app.acting_role', ${user?.actingRole ?? ''}, true),
           set_config('app.os_user', ${operator?.osUser ?? ''}, true),
           set_config('app.os_host', ${operator?.host ?? ''}, true),
           set_config('app.request_id', ${requestId}, true)`;
}

function backoff(baseDelayMs: number, attempt: number): Promise<void> {
  const delay = baseDelayMs * 2 ** attempt * (0.5 + Math.random() * 0.5);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

async function runAfterCommit(
  callbacks: (() => void | Promise<void>)[],
  logger: Logger,
): Promise<void> {
  for (const callback of callbacks) {
    try {
      await callback();
    } catch (error) {
      logger.error({ err: error }, 'afterCommit callback failed');
    }
  }
}

/**
 * Runs one short interactive transaction with the actor context set, explicit timeouts,
 * retries of serialization failures and deadlocks, and after-commit hooks (research R5,
 * ADR-0006). Overload surfaces as DatabaseUnavailableError (503), never a hang.
 */
export async function withTransaction<T>(
  options: TransactionOptions,
  fn: (tx: AuditedTransaction, hooks: TransactionHooks) => Promise<T>,
): Promise<T> {
  const retry = options.retry ?? DEFAULT_RETRY;
  const logger = options.logger ?? (defaultLogger ??= createLogger());

  for (let attempt = 0; ; attempt += 1) {
    const callbacks: (() => void | Promise<void>)[] = [];
    try {
      const result = await options.prisma.$transaction(
        async (tx) => {
          await setActorContext(tx, options.actor, options.requestId);
          return fn(tx as AuditedTransaction, {
            afterCommit: (callback) => callbacks.push(callback),
          });
        },
        { timeout: options.timeoutMs, maxWait: options.maxWaitMs },
      );
      await runAfterCommit(callbacks, logger);
      return result;
    } catch (error) {
      const kind = classifyDbError(error);
      if (kind === 'retryable') {
        if (attempt < retry.retries) {
          await backoff(retry.baseDelayMs, attempt);
          continue;
        }
        throw new ConcurrencyRetryExhaustedError(attempt + 1, { cause: error });
      }
      if (kind === 'unavailable') {
        throw new DatabaseUnavailableError({ cause: error });
      }
      throw error;
    }
  }
}

/** For the few queries that run outside a transaction (readiness): maps overload to 503. */
export async function withDatabase<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (classifyDbError(error) === 'unavailable') {
      throw new DatabaseUnavailableError({ cause: error });
    }
    throw error;
  }
}
