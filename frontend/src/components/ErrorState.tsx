import { Button } from 'react-aria-components';
import {
  describeFailure,
  isRetryable,
  type FormFields,
  type ProblemLike,
} from '../errors/messages';
import { classes } from '../styles/classes';
import css from './states.module.css';

const styles = classes(css, 'error', 'message', 'requestId', 'retry');

export interface ErrorStateProps {
  problem: ProblemLike;
  /** The wait from Retry-After, said in minutes for a lockout or rate limit. */
  retryAfterSeconds?: number | undefined;
  /** Labels for field errors, which an error screen says itself: it highlights none. */
  labels?: FormFields['labels'];
  /** Offered as Retry only for temporary failures (503-class codes). */
  onRetry?: () => void;
}

/**
 * The message for a problem (a revoke reason, a wait, field errors included), its next
 * step, the request id and, if it helps, Retry.
 */
export function ErrorState({ problem, retryAfterSeconds, labels, onRetry }: ErrorStateProps) {
  const { message, action } = describeFailure(
    { problem, retryAfterSeconds },
    labels ? { labels } : {},
  );
  return (
    <div role="alert" className={styles.error}>
      <p className={styles.message}>{message}</p>
      {action && <p>{action}</p>}
      {problem.correlationId && (
        <p className={styles.requestId}>
          Request ID: <code>{problem.correlationId}</code>
        </p>
      )}
      {onRetry && isRetryable(problem.code) && (
        <Button className={styles.retry} onPress={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
