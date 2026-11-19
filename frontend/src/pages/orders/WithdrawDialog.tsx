import { DECISION_REASON_MAX } from '@po/contracts';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { REASON_REQUIRED_MESSAGE } from '../../errors/messages';
import { isVersionConflict, useDialogAction } from '../../hooks/useDialogAction';
import { withdrawOrder, type Order } from './queries';

export interface WithdrawDialogProps {
  order: Order;
  onClose: () => void;
  onReload: () => void;
  onWithdrawn: (order: Order) => void;
}

/**
 * Withdraw pending order (ADR-0018 dialogs): a required reason; the order returns to Draft
 * and approval starts again on resubmit. Focus starts on "Keep it pending".
 */
export function WithdrawDialog({ order, onClose, onReload, onWithdrawn }: WithdrawDialogProps) {
  const action = useDialogAction();
  return (
    <ConfirmDialog
      title={`Withdraw ${order.poNumber}?`}
      confirmLabel="Withdraw"
      cancelLabel="Keep it pending"
      reason={{
        label: 'Reason',
        minLength: 1,
        maxLength: DECISION_REASON_MAX,
        required: { message: REASON_REQUIRED_MESSAGE, path: 'body.reason' },
      }}
      onConfirm={(reason = '') =>
        action.run(() => withdrawOrder(order.id, order.version, reason), onWithdrawn)
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
      <p>It returns to Draft, and approval starts again when you resubmit.</p>
    </ConfirmDialog>
  );
}
