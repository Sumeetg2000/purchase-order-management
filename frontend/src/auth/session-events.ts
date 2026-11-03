import type { ProblemLike } from '../errors/messages';

// The session ended under the user (a refresh failed, or the account was deactivated).
// The API client reports it here; the session boundary sends the user to login.

type Listener = (problem: ProblemLike) => void;
const listeners = new Set<Listener>();

export function onSessionEnded(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function endSession(problem: ProblemLike): void {
  for (const listener of listeners) listener(problem);
}
