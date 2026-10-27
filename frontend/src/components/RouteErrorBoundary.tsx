import { isRouteErrorResponse, useRouteError } from 'react-router';
import type { ProblemLike } from '../errors/messages';
import { problemFrom } from '../errors/problem';
import { ErrorState } from './ErrorState';

/**
 * A route's errorElement: contains a failure to that route, so the shell and its
 * navigation keep working, and shows the failing request's id to quote, if there was one.
 */
export function RouteErrorBoundary() {
  const error = useRouteError();
  const problem: ProblemLike =
    isRouteErrorResponse(error) && error.status === 404
      ? { code: 'NOT_FOUND' }
      : problemFrom(error);
  return <ErrorState problem={problem} />;
}
