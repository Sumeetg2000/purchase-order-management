import { OPERATIONS, ROLE, type OperationContract, type UserRole } from '@po/contracts';
import { useCurrentUser } from './current-user';

export type OperationName = keyof typeof OPERATIONS;

/**
 * Whether a user with these roles (null: logged out) may call the operation, by the same
 * access rule the API enforces (OPERATIONS). The screens only hide what the API refuses.
 */
export function canCall(
  operation: OperationName,
  user: { roles: readonly UserRole[] } | null | undefined,
): boolean {
  const { access, roles: allowed }: OperationContract = OPERATIONS[operation];
  if (access === 'public') return true;
  if (!user) return false;
  switch (access) {
    case 'refresh':
    case 'user':
      return true;
    case 'no-role':
      return user.roles.length === 0;
    case 'admin':
      return user.roles.includes(ROLE.ADMIN);
    case 'role':
      return user.roles.some((role) => allowed?.includes(role) === true);
  }
}

/** Whether the current user may call the operation; false while the user loads. */
export function useCan(operation: OperationName): boolean {
  return canCall(operation, useCurrentUser().data);
}
