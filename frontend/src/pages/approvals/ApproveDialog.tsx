import { formatInr, toMoney, type ErrorCode } from '@po/contracts';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { reloadOrderAction, useDialogAction } from '../../hooks/useDialogAction';
import type { Order } from '../orders/queries';
import { approveOrder } from './queries';

export interface ApproveDialogProps {
  order: Order;
  onClose: () => void;
  /** Rereads the order: Reload order, and closing after ORDER_OWNER_INACTIVE. */
  onReload: () => void;
  onApproved: (order: Order) => void;
}

/**
 * Approve (ADR-0018 dialogs): the PO number, buyer, vendor as submitted and total, and
 * that the buyer can then receive goods and the order can't be edited. Focus starts on
 * "Not now". When the owner can no longer act (ORDER_OWNER_INACTIVE), the dialog says so
 * and closing it rereads the order, so the page shows the marker and offers Reject only
 * (contracts/ui.md); the dialog itself offers no other decision.
 */
export function ApproveDialog({ order, onClose, onReload, onApproved }: ApproveDialogProps) {
  const action = useDialogAction();
  const close = () => {
    if (action.error?.problem.code === ('ORDER_OWNER_INACTIVE' satisfies ErrorCode)) onReload();
    onClose();
  };
  return (
    <ConfirmDialog
      title={`Approve ${order.poNumber}?`}
      confirmLabel="Approve"
      cancelLabel="Not now"
      onConfirm={() => action.run(() => approveOrder(order.id, order.version), onApproved)}
      onClose={close}
      error={action.error}
      errorActions={reloadOrderAction(action.error, onReload, onClose)}
    >
      <p>
        Raised by {order.owner.name} · {order.vendorSnapshot?.name ?? order.vendor.name} ·{' '}
        {formatInr(toMoney(order.total))}
      </p>
      <p>The buyer can then receive goods; the order can&apos;t be edited.</p>
    </ConfirmDialog>
  );
}
