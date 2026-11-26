import { lineNumber, type ErrorCode } from '@po/contracts';
import { useEffect, useRef, useState } from 'react';
import { useCurrentUser } from '../../auth/current-user';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { formatDate } from '../../format/date';
import { dateBeforeApprovalMessage, messageForOrderAction } from '../../errors/messages';
import { reloadAction, useDialogAction } from '../../hooks/useDialogAction';
import { recordReceipt, type Order, type RecordReceiptBody } from './queries';
import { fullyReceivedWarning } from './receipt-progress';

/** One line of the receipt, as the dialog states it. */
export interface ReceiptLinePlan {
  lineId: string;
  position: number;
  quantity: number;
  receivedSoFar: number;
  outstandingAfter: number;
}

/** Failures meaning the order behind the dialog has changed: reload it. */
const RECEIPT_STALE_CODES = [
  'RECEIPT_EXCEEDS_OUTSTANDING',
  'ORDER_NOT_RECEIVABLE',
  'NOT_FOUND',
] as const satisfies readonly ErrorCode[];
const isReceiptStale = (code: string): boolean =>
  (RECEIPT_STALE_CODES as readonly string[]).includes(code);

export interface ReceiptDialogProps {
  order: Order;
  plan: readonly ReceiptLinePlan[];
  body: RecordReceiptBody;
  onClose: () => void;
  onReload: () => void;
  /** The lines an over-receipt named, for the form to mark. */
  onExceeded: (lineIds: readonly string[]) => void;
  onRecorded: () => void;
}

/**
 * The receipt dialog (ADR-0018, contracts/ui.md): per line what it receives, what was
 * received so far and what stays outstanding, and a warning for each line it completes,
 * since receipts can't be changed. Focus starts on "Go back". One Idempotency-Key per
 * opening, reused on a retry; a double click sends one request.
 */
export function ReceiptDialog({
  order,
  plan,
  body,
  onClose,
  onReload,
  onExceeded,
  onRecorded,
}: ReceiptDialogProps) {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const action = useDialogAction();
  const roles = useCurrentUser().data?.roles ?? [];
  const problem = action.error?.problem;
  // The form passes a new callback each render, and calling it re-renders the form: run
  // this once per problem, with the latest callback, or the two would loop.
  const exceeded = useRef(onExceeded);
  useEffect(() => {
    exceeded.current = onExceeded;
  });
  useEffect(() => {
    if (problem?.code === 'RECEIPT_EXCEEDS_OUTSTANDING') {
      exceeded.current((problem.lines ?? []).map((line) => line.lineId));
    }
  }, [problem]);
  return (
    <ConfirmDialog
      title={`Record receipt for ${order.poNumber}?`}
      confirmLabel="Record receipt"
      cancelLabel="Go back"
      onConfirm={() => action.run(() => recordReceipt(order.id, body, idempotencyKey), onRecorded)}
      onClose={onClose}
      error={action.error}
      errorLabels={{ 'body.receivedOn': 'Receipt date', 'body.note': 'Note' }}
      errorMessageFor={(failed) => messageForOrderAction(failed, { roles, action: 'receipt' })}
      errorFieldText={(detail) =>
        detail.code === 'DATE_BEFORE_APPROVAL' && order.approvedAt !== null
          ? dateBeforeApprovalMessage(formatDate(order.approvedAt))
          : undefined
      }
      errorActions={reloadAction(action.error, isReceiptStale, onReload, {
        label: 'Reload order',
        onClose,
      })}
    >
      <ul>
        {plan.map((line) => (
          <li key={line.lineId}>
            Line {lineNumber(line.position)}: receiving {line.quantity}, received so far{' '}
            {line.receivedSoFar}, outstanding after {line.outstandingAfter}
            {line.outstandingAfter === 0 && <p>{fullyReceivedWarning(line.position)}</p>}
          </li>
        ))}
      </ul>
      <p>Received on {formatDate(body.receivedOn)}. Receipts can&apos;t be changed or undone.</p>
    </ConfirmDialog>
  );
}
