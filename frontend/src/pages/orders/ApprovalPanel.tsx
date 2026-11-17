import { formatInr, toMoney } from '@po/contracts';
import { classes } from '../../styles/classes';
import type { Order } from './queries';
import css from './orders.module.css';

const styles = classes(css, 'details', 'term');

type Round = NonNullable<Order['approval']>;
type Step = Round['steps'][number];

/** One step's state in words: who decided, and why for a rejection. */
function stepState(step: Step): string {
  const by = step.decidedBy?.name;
  switch (step.state) {
    case 'OPEN':
      return 'Waiting';
    case 'APPROVED':
      return `Approved by ${by ?? 'an Approver'}`;
    case 'REJECTED':
      return `Rejected by ${by ?? 'an Approver'}${step.reason ? `: ${step.reason}` : ''}`;
    case 'VOIDED':
      return by ? `Approved by ${by}, then voided by a withdrawal` : 'Voided by a withdrawal';
  }
}

/**
 * The order's current approval round (research R10): each step with its threshold and
 * state, or the auto-approval; a withdrawn round's reason.
 */
export function ApprovalPanel({ round }: { round: Round }) {
  return (
    <section aria-label="Approval">
      <h2>Approval</h2>
      {round.outcome === 'AUTO_APPROVED' && (
        <p>Approved automatically: at or below the threshold.</p>
      )}
      {round.outcome === 'WITHDRAWN' && round.withdrawReason !== null && (
        <p>Withdrawn: {round.withdrawReason}</p>
      )}
      {round.steps.length > 0 && (
        <dl className={styles.details}>
          {round.steps.map((step) => (
            <div key={step.step}>
              <dt className={styles.term}>
                Step {step.step} · above {formatInr(toMoney(step.threshold))}
              </dt>
              <dd>{stepState(step)}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
