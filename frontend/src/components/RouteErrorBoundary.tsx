import { isRouteErrorResponse, useRouteError } from 'react-router';
import { getLastRequestId, ProblemError } from '../api/client';
import type { ProblemLike } from '../errors/messages';
import { ErrorState } from './ErrorState';

/**
 * A route's errorElement: contains a failure to that route, so the shell and its
 * navigation keep working, and shows the request id to quote.
 */
export function RouteErrorBoundary() {
  const error = useRouteError();
  let problem: ProblemLike;
  if (error instanceof ProblemError) problem = error.problem;
  else if (isRouteErrorResponse(error) && error.status === 404) problem = { code: 'NOT_FOUND' };
  else problem = { code: 'INTERNAL_ERROR', correlationId: getLastRequestId() };
  return <ErrorState problem={problem} />;
}
