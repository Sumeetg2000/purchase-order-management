import { AppError } from '@po/contracts';
import type { TransactionRunner } from '../db/transaction.js';
import type { RequestContext } from '../lib/request-context.js';
import { plus, secondsUntil } from '../lib/time.js';
import { logSecurityEvent } from '../observability/security-log.js';
import { recordFailedLogin } from '../users/repository.js';
import { LOCKOUT_DURATION_SECONDS, LOCKOUT_THRESHOLD } from './constants.js';

// The account lockout (ADR-0017 "Lockout"), shared by every check of a password the user
// already has: login, change-password and verify-email.

/** 423 ACCOUNT_LOCKED, saying when to try again. */
export function lockedError(lockedUntil: Date, now: Date): AppError {
  return new AppError('ACCOUNT_LOCKED', { retryAfterSeconds: secondsUntil(lockedUntil, now) });
}

/**
 * A wrong password: it counts toward the lockout, in a transaction of its own. The
 * attempt that reaches the threshold locks the account and gets the lockout error.
 */
export async function countWrongPassword(
  transactions: TransactionRunner,
  userId: string,
  now: Date,
  ctx: RequestContext,
): Promise<AppError | undefined> {
  const outcome = await transactions.run(
    { actor: { type: 'SYSTEM' }, requestId: ctx.requestId, logger: ctx.logger },
    (tx) =>
      recordFailedLogin(tx, {
        id: userId,
        threshold: LOCKOUT_THRESHOLD,
        now,
        lockUntil: plus(now, LOCKOUT_DURATION_SECONDS),
      }),
  );
  if (!outcome.locked) return undefined;
  // One event per lock: attempts queued behind the one that locked it are refused quietly.
  if (outcome.justLocked) {
    logSecurityEvent(ctx.logger, 'account_locked', {
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      userId,
    });
  }
  return lockedError(outcome.lockedUntil, now);
}
