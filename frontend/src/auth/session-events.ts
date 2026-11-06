import type { ProblemLike } from '../errors/messages';

// The session ended under the user (a refresh failed, or the account was deactivated).
// The API client reports it here; the session boundary sends the user to login.

type Listener = (problem: ProblemLike) => void;
const listeners = new Set<Listener>();

// Why the last session ended, until the next login. A page load whose first call ends the
// session is also redirected by RequireUser, which may land after the boundary's own
// navigation (the login page loads lazily); it passes this on, so the reason isn't lost.
let lastEnded: ProblemLike | undefined;

/** Why the session ended, if it ended in this tab since the last login. */
export function endedSession(): ProblemLike | undefined {
  return lastEnded;
}

/** A new session began: earlier reasons no longer apply. */
export function clearEndedSession(): void {
  lastEnded = undefined;
}

export function onSessionEnded(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function endSession(problem: ProblemLike): void {
  lastEnded = problem;
  for (const listener of listeners) listener(problem);
}

// A call answered NO_ROLE_ASSIGNED: the user has no role yet, and belongs on Access pending.

const noRoleListeners = new Set<() => void>();

export function onNoRoleAssigned(listener: () => void): () => void {
  noRoleListeners.add(listener);
  return () => noRoleListeners.delete(listener);
}

export function noRoleAssigned(): void {
  for (const listener of noRoleListeners) listener();
}
