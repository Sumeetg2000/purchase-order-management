import { useNavigate } from 'react-router';
import { LOGIN_PATH, type LoginState } from './return-to';
import { clearEndedSession } from './session-events';

/**
 * Goes to login after a logout the user asked for (the shell's Log out, revoking this
 * session, logging out everywhere). The login page forgets the user once it shows.
 */
export function useLogOutHere() {
  const navigate = useNavigate();
  return async () => {
    // Logged out on purpose: no earlier reason applies any more.
    clearEndedSession();
    const state: LoginState = { loggedOut: true };
    await navigate(LOGIN_PATH, { replace: true, state });
  };
}
