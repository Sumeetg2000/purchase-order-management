import { Navigate, Outlet } from 'react-router';
import { useCurrentUser } from './current-user';

/**
 * Pages for users with a role. A verified user with none belongs on Access pending
 * (ADR-0018); the API refuses them anyway (NO_ROLE_ASSIGNED). Inside RequireUser, so the
 * user is loaded.
 */
export function RequireRole() {
  const user = useCurrentUser().data;
  if (user?.roles.length === 0) return <Navigate to="/access-pending" replace />;
  return <Outlet />;
}
