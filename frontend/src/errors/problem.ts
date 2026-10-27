import { NetworkError, ProblemError } from '../api/client';
import type { ProblemLike } from './messages';

/**
 * What an error screen shows for any error. An API error keeps its own problem and request
 * id; an unreachable API is a temporary failure (SERVICE_UNAVAILABLE), with no request id
 * since no request arrived; anything else is INTERNAL_ERROR with no request id, because the
 * id of some other request would mislead whoever quotes it.
 */
export function problemFrom(error: unknown): ProblemLike {
  if (error instanceof ProblemError) return error.problem;
  if (error instanceof NetworkError) return { code: 'SERVICE_UNAVAILABLE' };
  return { code: 'INTERNAL_ERROR' };
}
