import { Navigate, Outlet } from 'react-router';
import { Forbidden } from '../pages/Forbidden';
import { canCall, type OperationName } from './can';
import { useCurrentUser } from './current-user';

/**
 * Pages for users with a role, or for those who may call `operation` when given (its
 * access in OPERATIONS). A verified user with none belongs on Access pending (ADR-0018);
 * one without it sees the 403 page. These only hide: the API refuses anyway
 * (NO_ROLE_ASSIGNED, FORBIDDEN). Inside RequireUser, so the user is loaded.
 */
export function RequireRole({ operation }: { operation?: OperationName }) {
  const user = useCurrentUser().data;
  if (user?.roles.length === 0) return <Navigate to="/access-pending" replace />;
  if (operation !== undefined && user && !canCall(operation, user)) return <Forbidden />;
  return <Outlet />;
}
