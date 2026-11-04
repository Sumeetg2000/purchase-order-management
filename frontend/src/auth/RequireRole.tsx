import type { UserRole } from '@po/contracts';
import { Navigate, Outlet } from 'react-router';
import { Forbidden } from '../pages/Forbidden';
import { useCurrentUser } from './current-user';

/**
 * Pages for users with a role, or with the `requires` role when given. A verified user with none
 * belongs on Access pending (ADR-0018); one without it sees the 403 page. These only
 * hide: the API refuses anyway (NO_ROLE_ASSIGNED, FORBIDDEN). Inside RequireUser, so the
 * user is loaded.
 */
export function RequireRole({ requires }: { requires?: UserRole }) {
  const user = useCurrentUser().data;
  if (user?.roles.length === 0) return <Navigate to="/access-pending" replace />;
  if (requires && user && !user.roles.includes(requires)) return <Forbidden />;
  return <Outlet />;
}
