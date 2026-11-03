import type { Me } from '@po/contracts';
import type { ProfileUser } from './repository.js';

/** A user as GET /me and login show them to themselves. */
export function toMe(user: ProfileUser): Me {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    roles: user.roles,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
  };
}
