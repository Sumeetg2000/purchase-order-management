import { formatInr, toMoney } from '@po/contracts';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { isVersionConflict, useDialogAction } from '../../hooks/useDialogAction';
import type { Order } from '../orders/queries';
import { approveOrder } from './queries';

export interface ApproveDialogProps {
  order: Order;
  onClose: () => void;
  /** Rereads the order, for Reload order after a version conflict. */
  onReload: () => void;
  onApproved: (order: Order) => void;
}

/**
 * Approve (ADR-0018 dialogs): the PO number, buyer, vendor as submitted and total, and
 * that the buyer can then receive goods and the order can't be edited. Focus starts on
 * "Not now".
 */
export function ApproveDialog({ order, onClose, onReload, onApproved }: ApproveDialogProps) {
  const action = useDialogAction();
  return (
    <ConfirmDialog
      title={`Approve ${order.poNumber}?`}
      confirmLabel="Approve"
      cancelLabel="Not now"
      onConfirm={() => action.run(() => approveOrder(order.id, order.version), onApproved)}
      onClose={onClose}
      error={action.error}
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
      <p>
        Raised by {order.owner.name} · {order.vendorSnapshot?.name ?? order.vendor.name} ·{' '}
        {formatInr(toMoney(order.total))}
      </p>
      <p>The buyer can then receive goods; the order can&apos;t be edited.</p>
    </ConfirmDialog>
  );
}
