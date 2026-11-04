import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { CURRENT_USER_KEY } from './current-user';
import { clearEndedSession } from './session-events';

/**
 * Forgets the user in this tab and goes to login, after a logout the user asked for: the
 * shell's Log out, revoking this session, or logging out everywhere.
 */
export function useLogOutHere() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    // Logged out on purpose: no earlier reason applies any more.
    clearEndedSession();
    queryClient.setQueryData(CURRENT_USER_KEY, null);
    await navigate('/login', { replace: true });
  };
}
