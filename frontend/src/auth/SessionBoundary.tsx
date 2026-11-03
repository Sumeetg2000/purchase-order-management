import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { CURRENT_USER_KEY } from './current-user';
import { onNoRoleAssigned, onSessionEnded } from './session-events';
import { loginPath } from './return-to';

/**
 * The root of every page: when the session ends under the user (a failed refresh, a
 * deactivation), forget them and go to login, keeping the page to return to and why
 * (ADR-0018).
 */
export function SessionBoundary() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const here = `${location.pathname}${location.search}`;

  useEffect(
    () =>
      onSessionEnded((problem) => {
        queryClient.setQueryData(CURRENT_USER_KEY, null);
        void navigate(loginPath(here), { replace: true, state: { ended: problem } });
      }),
    [navigate, queryClient, here],
  );

  useEffect(
    () =>
      onNoRoleAssigned(() => {
        // The cached user may still hold the role an admin just removed: read it again, so
        // the guards agree with the API and don't send the user back and forth.
        void queryClient
          .invalidateQueries({ queryKey: CURRENT_USER_KEY })
          .then(() => navigate('/access-pending', { replace: true }));
      }),
    [navigate, queryClient],
  );

  return <Outlet />;
}
