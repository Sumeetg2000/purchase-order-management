import { DECISION_REASON_MAX, formatInr, lineNumber, toMoney } from '@po/contracts';
import { useCurrentUser } from '../../auth/current-user';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { messageForOrderAction, REASON_REQUIRED_MESSAGE } from '../../errors/messages';
import { reloadOrderAction, useDialogAction } from '../../hooks/useDialogAction';
import { cancelOrder, type Order } from './queries';
import { receivedLinesOf, receivedSummary } from './receipt-progress';

export interface CancelDialogProps {
  order: Order;
  onClose: () => void;
  onReload: () => void;
  onCancelled: (order: Order) => void;
}

/**
 * Cancel approved order (ADR-0018 dialogs, contracts/ui.md): names the order, its buyer,
 * vendor and total and what was received, per line and in sum; a required reason;
 * cancelling is final. Focus starts on "Keep order".
 */
export function CancelDialog({ order, onClose, onReload, onCancelled }: CancelDialogProps) {
  const action = useDialogAction();
  const roles = useCurrentUser().data?.roles ?? [];
  const vendor = order.vendorSnapshot?.name ?? order.vendor.name;
  return (
    <ConfirmDialog
      title={`Cancel ${order.poNumber}?`}
      confirmLabel="Cancel order"
      cancelLabel="Keep order"
      tone="danger"
      reason={{
        label: 'Reason',
        minLength: 1,
        maxLength: DECISION_REASON_MAX,
        required: { message: REASON_REQUIRED_MESSAGE, path: 'body.reason' },
      }}
      onConfirm={(reason = '') =>
        action.run(() => cancelOrder(order.id, order.version, reason), onCancelled)
      }
      onClose={onClose}
      error={action.error}
      errorLabels={{ 'body.reason': 'Reason' }}
      errorMessageFor={(problem) => messageForOrderAction(problem, { roles, action: 'cancel' })}
      errorActions={reloadOrderAction(action.error, onReload, onClose)}
    >
      <p>
        Raised by {order.owner.name} with {vendor}, total {formatInr(toMoney(order.total))}.
      </p>
      {order.receiptProgress === 'NOT_RECEIVED' ? (
        <p>Nothing has been received against this order.</p>
      ) : (
        <>
          <ul>
            {order.lines.map((line, position) => (
              <li key={line.id}>
                Line {lineNumber(position)}, {line.description}: ordered {line.quantity}, received{' '}
                {line.receivedQuantity}
              </li>
            ))}
          </ul>
          <p>{receivedSummary(receivedLinesOf(order.lines))}</p>
        </>
      )}
      <p>Cancelling is final. No further goods can be received against this order.</p>
    </ConfirmDialog>
  );
}
