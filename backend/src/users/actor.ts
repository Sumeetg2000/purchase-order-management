import { ROLE, SELF_ACTING_ROLE } from '@po/contracts';
import type { ActorContext } from '../db/transaction.js';

/** A user acting on their own account, as the audit records it (research R12). */
export function selfActor(user: { id: string; name: string; email: string }): ActorContext {
  return {
    type: 'USER',
    userId: user.id,
    name: user.name,
    email: user.email,
    actingRole: SELF_ACTING_ROLE,
  };
}

/** An admin acting on another user's account. */
export function adminActor(user: { id: string; name: string; email: string }): ActorContext {
  return {
    type: 'USER',
    userId: user.id,
    name: user.name,
    email: user.email,
    actingRole: ROLE.ADMIN,
  };
}
