import { formatInr, moneyAbove, toMoney } from '@po/contracts';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { reloadOrderAction, useDialogAction } from '../../hooks/useDialogAction';
import { submitOrder, useApprovalPolicy, type ApprovalPolicy, type Order } from './queries';

export interface SubmitDialogProps {
  order: Order;
  onClose: () => void;
  /** Rereads the order, for Reload order when it changed or is gone. */
  onReload: () => void;
  /** The order as the server routed it: the page shows the actual outcome. */
  onSubmitted: (order: Order) => void;
}

/**
 * What the published policy says will happen; the server's routing is what counts. If the
 * policy can't be read, the dialog says so: submitting still routes the order.
 */
function expectedOutcome(
  order: Order,
  policy: { data?: ApprovalPolicy | undefined; isError: boolean },
): string {
  if (policy.isError) {
    return "The expected outcome isn't available right now; submitting still routes the order.";
  }
  const lowest = policy.data?.tiers[0];
  if (!lowest) return 'Checking the approval policy… (expected: the result shows once you submit).';
  const expected = moneyAbove(toMoney(order.total), toMoney(lowest.threshold))
    ? 'Will go to the Approver for approval'
    : 'Will be auto-approved';
  return `${expected} (expected: the result shows once you submit).`;
}

/**
 * Submit order (specs/005-submit-approve/contracts/ui.md, ADR-0018): the saved total, the
 * expected outcome from GET /approval-policy, and that the order can't be edited after,
 * only withdrawn while pending. Focus starts on "Keep editing".
 */
export function SubmitDialog({ order, onClose, onReload, onSubmitted }: SubmitDialogProps) {
  const policy = useApprovalPolicy();
  const action = useDialogAction();
  const confirm = () => action.run(() => submitOrder(order.id, order.version), onSubmitted);
  return (
    <ConfirmDialog
      title={`Submit ${order.poNumber}?`}
      confirmLabel="Submit"
      cancelLabel="Keep editing"
      onConfirm={confirm}
      onClose={onClose}
      error={action.error}
      errorActions={reloadOrderAction(action.error, onReload, onClose)}
    >
      <p>
        {order.vendor.name} · {formatInr(toMoney(order.total))}
      </p>
      <p>{expectedOutcome(order, policy)}</p>
      <p>You can&apos;t edit it after submitting; you can withdraw it while it&apos;s pending.</p>
    </ConfirmDialog>
  );
}
