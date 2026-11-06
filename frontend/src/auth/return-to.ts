import type { ProblemLike } from '../errors/messages';

// Where to go after login. Only a path inside the app is followed: anything else (another
// origin, //host, a backslash trick) falls back to the home page.

const HOME = '/';

/** The login page. */
export const LOGIN_PATH = '/login';

/** What the app tells the login page when it sends the user there. */
export interface LoginState {
  /** Why the session ended, when a refresh failed and sent the user here. */
  ended?: ProblemLike;
  /** The user logged out on purpose (useLogOutHere): forget them once this page shows. */
  loggedOut?: true;
}

export function safeReturnTo(value: string | null): string {
  if (!value?.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return HOME;
  if (value === LOGIN_PATH || value.startsWith(`${LOGIN_PATH}?`)) return HOME;
  return value;
}

export function loginPath(returnTo: string): string {
  return `${LOGIN_PATH}?returnTo=${encodeURIComponent(returnTo)}`;
}
