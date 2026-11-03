import { isUserRole, USER_STATUSES, type UserRole, type UserStatus } from '@po/contracts';

// Stored codes, parsed where they leave the database. The CHECK constraints allow only
// the listed values; one the code doesn't know means code and database disagree, which
// must fail loudly rather than be skipped.

export function userStatusOf(user: { id: string; status: string }): UserStatus {
  const status = USER_STATUSES.find((known) => known === user.status);
  if (!status)
    throw new Error(`User ${user.id} has a status the code doesn't know: ${user.status}`);
  return status;
}

export function userRolesOf(user: { id: string; roles: readonly string[] }): UserRole[] {
  const unknown = user.roles.filter((role) => !isUserRole(role));
  if (unknown.length > 0) {
    throw new Error(`User ${user.id} holds roles the code doesn't know: ${unknown.join(', ')}`);
  }
  return user.roles.filter(isUserRole);
}
