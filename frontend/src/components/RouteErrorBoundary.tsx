import { Button } from 'react-aria-components';
import { isRouteErrorResponse, useRouteError } from 'react-router';
import { ChunkLoadError } from '../app/lazyPage';
import type { ProblemLike } from '../errors/messages';
import { problemFrom } from '../errors/problem';
import { classes } from '../styles/classes';
import { ErrorState } from './ErrorState';
import css from './states.module.css';

const styles = classes(css, 'error', 'message', 'retry');

/**
 * A route's errorElement: contains a failure to that route, so the shell and its
 * navigation keep working, and shows the failing request's id to quote, if there was one.
 * A page whose code can't be loaded (an open tab after a deploy) offers a reload instead.
 */
export function RouteErrorBoundary() {
  const error = useRouteError();
  if (error instanceof ChunkLoadError) {
    return (
      <div role="alert" className={styles.error}>
        <p className={styles.message}>A newer version of the app is available.</p>
        <p>Reload the page to continue.</p>
        <Button
          className={styles.retry}
          onPress={() => {
            window.location.reload();
          }}
        >
          Reload
        </Button>
      </div>
    );
  }
  const problem: ProblemLike =
    isRouteErrorResponse(error) && error.status === 404
      ? { code: 'NOT_FOUND' }
      : problemFrom(error);
  return <ErrorState problem={problem} />;
}
