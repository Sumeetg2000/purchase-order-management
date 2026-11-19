import { formatInr, toMoney } from '@po/contracts';
import { formatDateTime } from '../../format/date';
import { classes } from '../../styles/classes';
import type { Order } from './queries';
import css from './orders.module.css';

const styles = classes(css, 'details', 'term');

type Round = NonNullable<Order['approval']>;
type Step = Round['steps'][number];

/** Who decided a step, and when: "Asha Approver on 18 November 2026 at 11:00 am". */
function decision(step: Step): string {
  const by = step.decidedBy?.name ?? 'an Approver';
  return step.decidedAt === null ? by : `${by} on ${formatDateTime(step.decidedAt)}`;
}

/**
 * One step's state in words: who decided and when, and why for a rejection. A voided step
 * names what voided it: the round's rejection (the steps after the rejected one) or a
 * withdrawal (every step of the round).
 */
function stepState(step: Step, outcome: Round['outcome']): string {
  switch (step.state) {
    case 'OPEN':
      return 'Waiting';
    case 'APPROVED':
      return `Approved by ${decision(step)}`;
    case 'REJECTED':
      return `Rejected by ${decision(step)}${step.reason ? `: ${step.reason}` : ''}`;
    case 'VOIDED': {
      const voided = outcome === 'REJECTED' ? 'the rejection' : 'a withdrawal';
      return step.decidedBy
        ? `Approved by ${decision(step)}, then voided by ${voided}`
        : `Voided by ${voided}`;
    }
  }
}

/**
 * The order's current approval round (research R10): its number and the policy version
 * that routed it; each step with its threshold and state, or the auto-approval; a
 * withdrawn round's reason.
 */
export function ApprovalPanel({ round }: { round: Round }) {
  return (
    <section aria-label="Approval">
      <h2>Approval</h2>
      <p>
        Round {round.round} · policy version {round.policyVersion}
      </p>
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
              <dd>{stepState(step, round.outcome)}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
