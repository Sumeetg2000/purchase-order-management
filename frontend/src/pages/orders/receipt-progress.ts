import { lineNumber, type OrderStatus, type ReceiptProgress } from '@po/contracts';

// The receipt words, in one place (specs/007-goods-receipt/research.md R8, R12,
// contracts/ui.md): the received summary, the badges, the fully-received warning and the
// Admin's open-order counts. Positions count from 0; lines are numbered from 1.

/** An order's lines by how much of each was received. */
export interface ReceivedLines {
  complete: number;
  partly: number;
  total: number;
}

/** "2 of 5 lines complete, 1 partly received", a zero part left out; or "Nothing received". */
export function receivedSummary({ complete, partly, total }: ReceivedLines): string {
  if (complete === 0 && partly === 0) return 'Nothing received';
  const ofLines = `of ${String(total)} line${total === 1 ? '' : 's'}`;
  if (complete === 0) return `${String(partly)} ${ofLines} partly received`;
  const done = `${String(complete)} ${ofLines} complete`;
  return partly === 0 ? done : `${done}, ${String(partly)} partly received`;
}

/** A cancelled order's summary line. */
export function cancelledSummary(lines: ReceivedLines): string {
  return `Cancelled · ${receivedSummary(lines)}`;
}

/** How much of one line was received: "60 of 100 received". */
export function lineReceivedText(received: number, ordered: number): string {
  return `${String(received)} of ${String(ordered)} received`;
}

/** The badge beside the status; none when nothing is received or receipts can't apply. */
export function receiptBadge(status: OrderStatus, progress: ReceiptProgress): string | undefined {
  if (status === 'APPROVED') {
    if (progress === 'PARTIALLY_RECEIVED') return 'Partly received';
    if (progress === 'FULLY_RECEIVED') return 'Fully received';
  }
  if (status === 'CANCELLED' && progress === 'PARTIALLY_RECEIVED') {
    return 'Cancelled · partly received';
  }
  return undefined;
}

/** The receipt dialog's warning for each line the receipt would fully receive. */
export function fullyReceivedWarning(position: number): string {
  return `This marks line ${String(lineNumber(position))} as fully received. Receipts can't be changed or undone.`;
}

/** A user's open orders, as the Admin's dialogs show them. */
export interface OpenOrders {
  draft: number;
  pending: number;
  approvedWithOpenLines: number;
}

/** "2 drafts · 1 pending · 2 approved with goods to receive". */
export function openOrdersCounts({ draft, pending, approvedWithOpenLines }: OpenOrders): string {
  return `${String(draft)} draft${draft === 1 ? '' : 's'} · ${String(pending)} pending · ${String(approvedWithOpenLines)} approved with goods to receive`;
}

/** What happens to a user's open orders when their roles change or they are deactivated. */
export const OPEN_ORDERS_NEXT_STEPS =
  'An Approver rejects their pending orders and cancels their approved ones; a buyer raises new orders if still needed.';

/** The next steps, shown only when the user has any open order. */
export function openOrdersNote(counts: OpenOrders): string | undefined {
  const open = counts.draft + counts.pending + counts.approvedWithOpenLines;
  return open > 0 ? OPEN_ORDERS_NEXT_STEPS : undefined;
}
