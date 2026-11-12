import type { ActingRole } from '@po/contracts';
import type {
  ActorContext,
  AuditedTransaction,
  TransactionHooks,
  TransactionRunner,
} from '../db/transaction.js';
import type { RequestContext } from '../lib/request-context.js';

/** The system acting on its own: a token consumed, a login counted, a seed or bootstrap. */
export const SYSTEM_ACTOR = { type: 'SYSTEM' } as const satisfies ActorContext;

/** Who a user is, as the audit records them. */
interface ActingUser {
  userId: string;
  name: string;
  email: string;
}

/**
 * A user acting in `role`: SELF on their own account (research R12), ADMIN on another
 * user's, BUYER on shared data such as a vendor (a Buyer who is also an Approver acts as
 * Buyer).
 */
export function userActor(user: ActingUser, role: ActingRole): ActorContext {
  return {
    type: 'USER',
    userId: user.userId,
    name: user.name,
    email: user.email,
    actingRole: role,
  };
}

/** Runs `fn` in one audited transaction as `user` acting in `role`. */
export function runAs<T>(
  transactions: TransactionRunner,
  user: ActingUser,
  role: ActingRole,
  ctx: Pick<RequestContext, 'requestId' | 'logger'>,
  fn: (tx: AuditedTransaction, hooks: TransactionHooks) => Promise<T>,
): Promise<T> {
  return transactions.run(
    { actor: userActor(user, role), requestId: ctx.requestId, logger: ctx.logger },
    fn,
  );
}
