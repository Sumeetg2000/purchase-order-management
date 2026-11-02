import { Button } from 'react-aria-components';
import { isRetryable, messageFor, type ProblemLike } from '../errors/messages';
import { classes } from '../styles/classes';
import css from './states.module.css';

const styles = classes(css, 'error', 'message', 'requestId', 'retry');

export interface ErrorStateProps {
  problem: ProblemLike;
  /** Offered as Retry only for temporary failures (503-class codes). */
  onRetry?: () => void;
}

/** The mapped message for a problem, its next step, the request id and, if it helps, Retry. */
export function ErrorState({ problem, onRetry }: ErrorStateProps) {
  const { message, action } = messageFor(problem.code);
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
