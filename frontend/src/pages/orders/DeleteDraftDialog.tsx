import { DELETE_REASON_MAX, etagFor, formatInr, toMoney } from '@po/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { api } from '../../api/app-client';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { isVersionConflict, useDialogAction } from '../../hooks/useDialogAction';
import { ORDERS_KEY, type Order } from './queries';

export interface DeleteDraftDialogProps {
  order: Order;
  onClose: () => void;
  /** Rereads the order, for Reload order after a version conflict. */
  onReload: () => void;
}

/**
 * Delete draft (contracts/ui.md, ADR-0018 dialogs): names the draft, its vendor, line count and
 * total, says the deletion is permanent and that its owner won't see it or its history
 * again; an optional reason; focus starts on "Keep draft". On success the order is gone,
 * so the page moves to the orders list.
 */
export function DeleteDraftDialog({ order, onClose, onReload }: DeleteDraftDialogProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const action = useDialogAction();

  const confirm = (reason?: string) =>
    action.run(
      () =>
        api.DELETE('/orders/{id}', {
          params: { path: { id: order.id }, header: { 'If-Match': etagFor(order.version) } },
          ...(reason ? { body: { reason } } : {}),
        }),
      () => {
        queryClient.removeQueries({ queryKey: [...ORDERS_KEY, 'order', order.id] });
        void queryClient.invalidateQueries({ queryKey: [...ORDERS_KEY, 'list'] });
        void navigate('/orders');
      },
    );

  const lines = order.lineCount === 1 ? '1 line' : `${String(order.lineCount)} lines`;
  return (
    <ConfirmDialog
      title={`Delete draft ${order.poNumber}?`}
      confirmLabel="Delete draft"
      cancelLabel="Keep draft"
      tone="danger"
      reason={{
        label: 'Reason (optional)',
        minLength: 1,
        maxLength: DELETE_REASON_MAX,
        optional: true,
      }}
      onConfirm={confirm}
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
      <p>
        {order.vendor.name} · {lines} · {formatInr(toMoney(order.total))}
      </p>
      <p>This permanently deletes the draft.</p>
      <p>You won&apos;t be able to see this draft or its history again.</p>
    </ConfirmDialog>
  );
}
