import { Navigate, Outlet, useLocation } from 'react-router';
import { ErrorState } from '../components/ErrorState';
import { Loading } from '../components/Loading';
import { problemFrom } from '../errors/problem';
import { useCurrentUser } from './current-user';
import { loginPath } from './return-to';
import { endedSession } from './session-events';

/** Pages behind a login: no user goes to login, keeping the page to return to. */
export function RequireUser() {
  const location = useLocation();
  const user = useCurrentUser();
  if (user.isPending) return <Loading label="Loading your account" />;
  if (user.isError) return <ErrorState problem={problemFrom(user.error)} />;
  if (user.data === null) {
    const ended = endedSession();
    return (
      <Navigate
        to={loginPath(`${location.pathname}${location.search}`)}
        replace
        state={ended ? { ended } : undefined}
      />
    );
  }
  return <Outlet />;
}
