import { AppError, USER_STATUS, type EmailBody, type SignupBody } from '@po/contracts';
import type { AppPrismaClient } from '../db/client.js';
import { violatedConstraint } from '../db/errors.js';
import { revokeUserSessions } from '../auth/repository.js';
import { commonPasswordError, hashPassword } from '../auth/passwords.js';
import { writeAudit } from '../audit/write.js';
import {
  actAs,
  withDatabase,
  type AuditedTransaction,
  type TransactionHooks,
  type TransactionRunner,
} from '../db/transaction.js';
import type { Clock } from '../lib/clock.js';
import type { RequestContext } from '../lib/request-context.js';
import type { MailDispatcher } from '../mail/dispatcher.js';
import { sendAfterCommit } from '../mail/send-after-commit.js';
import { verifyEmailTemplate } from '../mail/templates.js';
import { logSecurityEvent } from '../observability/security-log.js';
import type { RateLimiter } from '../rate-limit/service.js';
import { verifyEmailLink } from '../tokens/links.js';
import { consumeToken, issueToken } from '../tokens/one-time.js';
import {
  activateUser,
  createSignupUser,
  findLoginUser,
  lockUser,
  setPasswordAfterReset,
  type ProfileUser,
} from '../users/repository.js';

// Account self-service (ADR-0017): signup, verification by link, and setting a password
// by link. Slice 1 US5 adds forgot-password.

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
  /** Creates an UNVERIFIED account with no role and emails a verification link. */
  signup(input: SignupBody, ctx: RequestContext): Promise<void>;
  /** Activates an account from its verification link. Doesn't log the user in. */
  verifyEmail(token: string, ctx: RequestContext): Promise<void>;
  /** Emails a new verification link to an unverified account; the old one stops working. */
  resendVerification(input: EmailBody, ctx: RequestContext): Promise<void>;
}

export interface AccountsServiceDependencies {
  prisma: AppPrismaClient;
  transactions: TransactionRunner;
  rateLimiter: RateLimiter;
  mail: MailDispatcher;
  clock: Clock;
  /** APP_ORIGIN, for the links in emails. */
  appOrigin: string;
  /** SIGNUP_ALLOWED_DOMAINS, lower-cased. */
  signupDomains: readonly string[];
}

/** The user as their own actor, for self-service changes (research R12). */
function self(user: ProfileUser) {
  return {
    type: 'USER' as const,
    userId: user.id,
    name: user.name,
    email: user.email,
    actingRole: 'SELF',
  };
}

export function createAccountsService(deps: AccountsServiceDependencies): AccountsService {
  /** Issues a verification token and emails its link once the transaction commits. */
  async function sendVerification(
    tx: AuditedTransaction,
    hooks: TransactionHooks,
    user: ProfileUser,
    ctx: RequestContext,
  ) {
    const { token } = await issueToken(tx, user.id, 'VERIFY_EMAIL');
    sendAfterCommit(hooks, {
      mail: deps.mail,
      logger: ctx.logger,
      message: {
        template: verifyEmailTemplate,
        to: user.email,
        variables: { name: user.name, link: verifyEmailLink(deps.appOrigin, token) },
      },
    });
  }

  return {
    signup: async (input, ctx) => {
      const email = input.email.toLowerCase();
      // Counted before anything else, so refused attempts count too (research R8).
      await deps.rateLimiter.hit('signup-ip', ctx.ip);
      await deps.rateLimiter.hit('signup-email', email);
      const domain = email.slice(email.lastIndexOf('@') + 1);
      if (!deps.signupDomains.includes(domain)) throw new AppError('SIGNUP_DOMAIN_NOT_ALLOWED');
      const common = commonPasswordError('body.password', input.password);
      if (common) throw new AppError('VALIDATION_FAILED', { details: [common] });
      if (await withDatabase(() => findLoginUser(deps.prisma, email))) {
        throw new AppError('EMAIL_IN_USE');
      }
      const passwordHash = await hashPassword(input.password);

      const userId = await deps.transactions.run(
        // The system creates the account; then the new user acts for their own audit.
        { actor: { type: 'SYSTEM' }, requestId: ctx.requestId, logger: ctx.logger },
        async (tx, hooks) => {
          let user: ProfileUser;
          try {
            user = await createSignupUser(tx, { name: input.name, email, passwordHash });
          } catch (error) {
            // Someone else took the email since the lookup above.
            if (violatedConstraint(error) === 'users_email_key') {
              throw new AppError('EMAIL_IN_USE', { cause: error });
            }
            throw error;
          }
          await actAs(tx, self(user), ctx.requestId);
          await writeAudit(tx, {
            action: 'USER_SIGNED_UP',
            entityType: 'user',
            entityId: user.id,
            details: { emailDomain: domain, roles: [] },
          });
          await sendVerification(tx, hooks, user, ctx);
          return user.id;
        },
      );
      logSecurityEvent(ctx.logger, 'signup', { userId, ip: ctx.ip, userAgent: ctx.userAgent });
    },

    verifyEmail: async (token, ctx) => {
      const userId = await deps.transactions.run(
        { actor: { type: 'SYSTEM' }, requestId: ctx.requestId, logger: ctx.logger },
        async (tx) => {
          const consumed = await consumeToken(tx, 'VERIFY_EMAIL', token);
          if (!consumed.ok) throw new AppError(consumed.code);
          const user = await lockUser(tx, consumed.userId);
          if (!user) throw new Error(`token for a user that does not exist: ${consumed.userId}`);
          // Already active (a reset verified it first): the link has nothing left to do.
          if (user.status === USER_STATUS.UNVERIFIED) {
            await actAs(tx, self(user), ctx.requestId);
            await activateUser(tx, user.id);
            await writeAudit(tx, {
              action: 'USER_EMAIL_VERIFIED',
              entityType: 'user',
              entityId: user.id,
              details: { via: 'link' },
            });
          }
          return user.id;
        },
      );
      logSecurityEvent(ctx.logger, 'email_verified', {
        userId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    },

    resendVerification: async (input, ctx) => {
      const email = input.email.toLowerCase();
      await deps.rateLimiter.hit('resend-email', email);
      const user = await withDatabase(() => findLoginUser(deps.prisma, email));
      if (!user) throw new AppError('ACCOUNT_NOT_FOUND');
      if (user.status === USER_STATUS.DEACTIVATED) throw new AppError('ACCOUNT_DEACTIVATED');
      if (user.status === USER_STATUS.ACTIVE) throw new AppError('ACCOUNT_ALREADY_VERIFIED');
      await deps.transactions.run(
        { actor: { type: 'SYSTEM' }, requestId: ctx.requestId, logger: ctx.logger },
        (tx, hooks) => sendVerification(tx, hooks, user, ctx),
      );
    },

    resetPassword: async (input, ctx) => {
      const common = commonPasswordError('body.newPassword', input.newPassword);
      if (common) throw new AppError('VALIDATION_FAILED', { details: [common] });
      const now = deps.clock.now();

      const userId = await deps.transactions.run(
        // The system consumes the token; from then on the user it names acts.
        { actor: { type: 'SYSTEM' }, requestId: ctx.requestId, logger: ctx.logger },
        async (tx) => {
          const consumed = await consumeToken(tx, 'RESET', input.token);
          if (!consumed.ok) throw new AppError(consumed.code);
          // Hashed only once the link proved valid, so a junk token costs no hashing. The
          // token's row stays locked for the few tens of milliseconds this takes.
          const passwordHash = await hashPassword(input.newPassword);
          const user = await lockUser(tx, consumed.userId);
          if (!user) throw new Error(`token for a user that does not exist: ${consumed.userId}`);
          await actAs(tx, self(user), ctx.requestId);
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
