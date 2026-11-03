import { AppError, USER_STATUS } from '@po/contracts';
import { revokeUserSessions } from '../auth/repository.js';
import { commonPasswordError, hashPassword } from '../auth/passwords.js';
import { writeAudit } from '../audit/write.js';
import { actAs, type TransactionRunner } from '../db/transaction.js';
import type { Clock } from '../lib/clock.js';
import type { RequestContext } from '../lib/request-context.js';
import { logSecurityEvent } from '../observability/security-log.js';
import { consumeToken } from '../tokens/one-time.js';
import { activateUser, lockUser, setPasswordAfterReset } from '../users/repository.js';

// Account self-service by one-time link (ADR-0017). Slice 1 US2 and US5 add signup,
// verification, resend and forgot-password.

export interface ResetPasswordInput {
  token: string;
  newPassword: string;
}

export interface AccountsService {
  /**
   * Sets a new password from a reset or set-password link: every session ends, any
   * lockout clears, and an unverified user becomes active, since the link proved they
   * control the mailbox.
   */
  resetPassword(input: ResetPasswordInput, ctx: RequestContext): Promise<void>;
}

export function createAccountsService(deps: {
  transactions: TransactionRunner;
  clock: Clock;
}): AccountsService {
  return {
    resetPassword: async (input, ctx) => {
      const common = commonPasswordError('body.newPassword', input.newPassword);
      if (common) throw new AppError('VALIDATION_FAILED', { details: [common] });
      // Hashing takes tens of milliseconds; no transaction is held open for it.
      const passwordHash = await hashPassword(input.newPassword);
      const now = deps.clock.now();

      const userId = await deps.transactions.run(
        // The system consumes the token; from then on the user it names acts.
        { actor: { type: 'SYSTEM' }, requestId: ctx.requestId, logger: ctx.logger },
        async (tx) => {
          const consumed = await consumeToken(tx, 'RESET', input.token);
          if (!consumed.ok) throw new AppError(consumed.code);
          const user = await lockUser(tx, consumed.userId);
          if (!user) throw new Error(`token for a user that does not exist: ${consumed.userId}`);
          await actAs(
            tx,
            {
              type: 'USER',
              userId: user.id,
              name: user.name,
              email: user.email,
              actingRole: 'SELF',
            },
            ctx.requestId,
          );
          await setPasswordAfterReset(tx, user.id, passwordHash);
          if (user.status === USER_STATUS.UNVERIFIED) {
            await activateUser(tx, user.id);
            await writeAudit(tx, {
              action: 'USER_EMAIL_VERIFIED',
              entityType: 'user',
              entityId: user.id,
              details: { via: 'reset' },
            });
          }
          await revokeUserSessions(tx, { id: user.id, reason: 'PASSWORD_RESET', now });
          return user.id;
        },
      );
      logSecurityEvent(ctx.logger, 'password_reset_completed', {
        userId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    },
  };
}
