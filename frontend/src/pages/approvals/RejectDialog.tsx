import { DECISION_REASON_MAX } from '@po/contracts';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { REASON_REQUIRED_MESSAGE } from '../../errors/messages';
import { isVersionConflict, useDialogAction } from '../../hooks/useDialogAction';
import type { Order } from '../orders/queries';
import { rejectOrder } from './queries';

export interface RejectDialogProps {
  order: Order;
  onClose: () => void;
  onReload: () => void;
  onRejected: (order: Order) => void;
}

/**
 * Reject (ADR-0018 dialogs): a required reason; rejection is final and the buyer raises a
 * new order. Focus starts on "Not now".
 */
export function RejectDialog({ order, onClose, onReload, onRejected }: RejectDialogProps) {
  const action = useDialogAction();
  return (
    <ConfirmDialog
      title={`Reject ${order.poNumber}?`}
      confirmLabel="Reject"
      cancelLabel="Not now"
      tone="danger"
      reason={{
        label: 'Reason',
        minLength: 1,
        maxLength: DECISION_REASON_MAX,
        required: { message: REASON_REQUIRED_MESSAGE, path: 'body.reason' },
      }}
      onConfirm={(reason = '') =>
        action.run(() => rejectOrder(order.id, order.version, reason), onRejected)
      }
      onClose={onClose}
      error={action.error}
      errorLabels={{ 'body.reason': 'Reason' }}
      errorActions={
        action.error && isVersionConflict(action.error.problem.code)
          ? [
              {
                label: 'Reload order',
                onPress: () => {
                  onReload();
                  onClose();
                },
              },
            ]
          : []
      }
    >
      <p>Rejection is final; the buyer must raise a new order.</p>
    </ConfirmDialog>
  );
}
