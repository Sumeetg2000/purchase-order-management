import {
  formatInr,
  ORDER_OWNER_CANNOT_ACT_LABEL,
  ORDER_OWNER_INACTIVE_APPROVED_MARKER,
  ORDER_OWNER_INACTIVE_CANCEL_HINT,
  toMoney,
} from '@po/contracts';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { useCan } from '../../auth/can';
import { useCurrentUser } from '../../auth/current-user';
import { useQueryStates } from '../../hooks/useQueryStates';
import { classes } from '../../styles/classes';
import controlsCss from '../../styles/controls.module.css';
import { ApproveDialog } from '../approvals/ApproveDialog';
import { RejectDialog } from '../approvals/RejectDialog';
import { useRefreshApprovals } from '../approvals/queries';
import { formatPaymentTerms } from '../vendors/payment-terms';
import { VENDOR_STATUS_LABELS } from '../vendors/status';
import { ApprovalPanel } from './ApprovalPanel';
import { CancelDialog } from './CancelDialog';
import { CancellationSection } from './CancellationSection';
import { DeleteDraftDialog } from './DeleteDraftDialog';
import { OrderTabs } from './OrderTabs';
import { ReceiptForm } from './ReceiptForm';
import { ReceiptsSection } from './ReceiptsSection';
import {
  cancelledSummary,
  receiptBadge,
  receivedLinesOf,
  receivedSummary,
} from './receipt-progress';
import { useOrder, useOrderSaved, useReceiptRecorded, type Order } from './queries';
import { SubmitDialog } from './SubmitDialog';
import { WithdrawDialog } from './WithdrawDialog';
import { ORDER_STATUS_LABELS } from './status';
import css from './orders.module.css';

const controls = classes(controlsCss, 'button');
const styles = classes(
  css,
  'header',
  'badge',
  'details',
  'term',
  'lines',
  'number',
  'total',
  'notice',
  'snapshot',
);

/** What submitting did, in words: the server's routing, not the dialog's expectation. */
function submittedNotice(order: Order): string {
  return order.status === 'APPROVED'
    ? 'Submitted and approved automatically.'
    : 'Submitted. It is waiting for approval.';
}

/**
 * One order (specs/004-draft-orders/contracts/ui.md): its PO number, status, vendor as it
 * is now (with an Inactive badge), owner, lines in display order and the exact total in
 * rupees. Edit, delete and the timeline arrive with their stories.
 */
export function OrderDetail() {
  const { id = '' } = useParams();
  const query = useOrder(id);
  const states = useQueryStates(query, { loadingLabel: 'Loading the order' });
  const [deleting, setDeleting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [recording, setRecording] = useState(false);
  const receiptRecorded = useReceiptRecorded();
  // The editor's "Withdraw" (a pending order's stale save) opens the dialog here.
  // The request is cleared once read, so a refresh or Back doesn't open the dialog again.
  const location = useLocation();
  const navigate = useNavigate();
  const askedToWithdraw = (location.state as { withdraw?: boolean } | null)?.withdraw === true;
  const [withdrawing, setWithdrawing] = useState(askedToWithdraw);
  // Clears the request in place (same path, query and hash), so a refresh doesn't reopen it.
  useEffect(() => {
    if (askedToWithdraw) {
      void navigate(
        { pathname: location.pathname, search: location.search, hash: location.hash },
        { replace: true, state: null },
      );
    }
  }, [askedToWithdraw, location.pathname, location.search, location.hash, navigate]);
  const refreshApprovals = useRefreshApprovals();
  const [notice, setNotice] = useState<string>();
  const saved = useOrderSaved();
  const me = useCurrentUser().data;
  const canEdit = useCan('editOrder');
  const canDelete = useCan('deleteOrder');
  const canSubmit = useCan('submitOrder');
  const canApprove = useCan('approveOrder');
  const canReject = useCan('rejectOrder');
  const canWithdraw = useCan('withdrawOrder');
  const canCancel = useCan('cancelOrder');
  const canRecord = useCan('recordReceipt');
  if (states.view) {
    return (
      <>
        <title>Order · Purchase Orders</title>
        {states.view}
      </>
    );
  }
  const order = states.data;
  const ownDraft = order.status === 'DRAFT' && order.owner.id === me?.id;
  const pending = order.status === 'PENDING_APPROVAL';
  // Never on one's own order (ADR-0004), nor while its owner can't act (ADR-0001).
  const mayApprove = canApprove && pending && order.owner.id !== me?.id && order.ownerCanAct;
  // Reject stays open when the owner can't act: it is how such an order is closed.
  const mayReject = canReject && pending && order.owner.id !== me?.id;
  const mayWithdraw = canWithdraw && pending && order.owner.id === me?.id;
  // An Approver cancels an approved order they don't own (ADR-0001 T10, ADR-0004).
  const approved = order.status === 'APPROVED';
  // Nothing left to receive: a fully received order is never cancelled (ADR-0001 T10).
  const fullyReceived = order.receiptProgress === 'FULLY_RECEIVED';
  const mayCancel = canCancel && approved && !fullyReceived && order.owner.id !== me?.id;
  // Receipts apply once an order is approved; a cancelled one keeps what it received.
  const receivable = approved || order.status === 'CANCELLED';
  const progressBadge = receiptBadge(order.status, order.receiptProgress);
  // Only the owner records receipts, while something is still outstanding (ADR-0004).
  const mayRecord =
    canRecord &&
    approved &&
    order.owner.id === me?.id &&
    order.receiptProgress !== 'FULLY_RECEIVED';
  return (
    <>
      <title>{`${order.poNumber} · Purchase Orders`}</title>
      {states.notice}
      <div className={styles.header}>
        <h1>{order.poNumber}</h1>
        <span className={styles.badge}>{ORDER_STATUS_LABELS[order.status]}</span>
        {progressBadge && <span className={styles.badge}>{progressBadge}</span>}
        {mayRecord && !recording && (
          <button
            type="button"
            className={controls.button}
            onClick={() => {
              setRecording(true);
              setNotice(undefined);
            }}
          >
            Record receipt
          </button>
        )}
        {canEdit && ownDraft && <Link to={`/orders/${order.id}/edit`}>Edit</Link>}
        {canSubmit && ownDraft && (
          <button
            type="button"
            className={controls.button}
            onClick={() => {
              setSubmitting(true);
            }}
          >
            Submit
          </button>
        )}
        {mayApprove && (
          <button
            type="button"
            className={controls.button}
            onClick={() => {
              setApproving(true);
            }}
          >
            Approve
          </button>
        )}
        {mayReject && (
          <button
            type="button"
            className={controls.button}
            onClick={() => {
              setRejecting(true);
            }}
          >
            Reject
          </button>
        )}
        {mayWithdraw && (
          <button
            type="button"
            className={controls.button}
            onClick={() => {
              setWithdrawing(true);
            }}
          >
            Withdraw
          </button>
        )}
        {mayCancel && (
          <button
            type="button"
            className={controls.button}
            onClick={() => {
              setCancelling(true);
            }}
          >
            Cancel order
          </button>
        )}
        {pending && !order.ownerCanAct && (
          <span className={styles.badge}>{ORDER_OWNER_CANNOT_ACT_LABEL}</span>
        )}
        {canDelete && ownDraft && (
          <button
            type="button"
            className={controls.button}
            onClick={() => {
              setDeleting(true);
            }}
          >
            Delete draft
          </button>
        )}
      </div>
      {notice && (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
      {/* ADR-0004 S5, extended 2026-11-20: cancelling is how such an order is closed. */}
      {approved && !order.ownerCanAct && !fullyReceived && (
        <p className={styles.notice}>
          <span>{ORDER_OWNER_INACTIVE_APPROVED_MARKER}</span>
          {mayCancel && (
            <>
              {' '}
              <span>{ORDER_OWNER_INACTIVE_CANCEL_HINT}</span>
            </>
          )}
        </p>
      )}
      <OrderTabs id={order.id} />
      <dl className={styles.details}>
        <dt className={styles.term}>Vendor</dt>
        {/* A submitted order shows its vendor as submitted (ADR-0005); a draft, as it is now. */}
        <dd>
          {order.vendorSnapshot === null ? (
            <>
              {order.vendor.name}{' '}
              {order.vendor.status === 'INACTIVE' && (
                <span className={styles.badge}>{VENDOR_STATUS_LABELS.INACTIVE}</span>
              )}
            </>
          ) : (
            <VendorAsSubmitted snapshot={order.vendorSnapshot} />
          )}
        </dd>
        <dt className={styles.term}>Raised by</dt>
        <dd>{order.owner.name}</dd>
      </dl>
      <table className={styles.lines} aria-label="Lines">
        <thead>
          <tr>
            <th scope="col">Description</th>
            <th scope="col">Quantity</th>
            <th scope="col">Unit price</th>
            <th scope="col">Line total</th>
            {order.status !== 'DRAFT' && (
              <>
                <th scope="col">Received</th>
                <th scope="col">Outstanding</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {order.lines.map((line) => (
            <tr key={line.id}>
              <td>{line.description}</td>
              <td className={styles.number}>{line.quantity}</td>
              <td className={styles.number}>{formatInr(toMoney(line.unitPrice))}</td>
              <td className={styles.number}>{formatInr(toMoney(line.lineTotal))}</td>
              {order.status !== 'DRAFT' && (
                <>
                  <td className={styles.number}>{line.receivedQuantity}</td>
                  <td className={styles.number}>{line.outstandingQuantity}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <p className={styles.total}>
        <span>Total</span> <span data-testid="order-total">{formatInr(toMoney(order.total))}</span>
      </p>
      {receivable && (
        <p>
          {order.status === 'CANCELLED'
            ? cancelledSummary(receivedLinesOf(order.lines))
            : receivedSummary(receivedLinesOf(order.lines))}
        </p>
      )}
      {mayRecord && recording && (
        <ReceiptForm
          order={order}
          onClose={() => {
            setRecording(false);
          }}
          onReload={() => {
            void query.refetch();
          }}
          onRecorded={() => {
            setRecording(false);
            setNotice('Receipt recorded.');
            void receiptRecorded(order.id);
          }}
        />
      )}
      {order.cancellation && (
        <CancellationSection cancellation={order.cancellation} lines={order.lines} />
      )}
      {receivable && <ReceiptsSection order={order} />}
      {order.approval && <ApprovalPanel round={order.approval} />}
      {cancelling && (
        <CancelDialog
          order={order}
          onClose={() => {
            setCancelling(false);
          }}
          onReload={() => {
            void query.refetch();
          }}
          onCancelled={(closed) => {
            saved(closed);
            setCancelling(false);
            setNotice('Cancelled.');
          }}
        />
      )}
      {submitting && (
        <SubmitDialog
          order={order}
          onClose={() => {
            setSubmitting(false);
          }}
          onReload={() => {
            void query.refetch();
          }}
          onSubmitted={(routed) => {
            saved(routed);
            void refreshApprovals();
            setSubmitting(false);
            setNotice(submittedNotice(routed));
          }}
        />
      )}
      {rejecting && (
        <RejectDialog
          order={order}
          onClose={() => {
            setRejecting(false);
          }}
          onReload={() => {
            void query.refetch();
          }}
          onRejected={(decided) => {
            saved(decided);
            void refreshApprovals();
            setRejecting(false);
            setNotice('Rejected.');
          }}
        />
      )}
      {withdrawing && mayWithdraw && (
        <WithdrawDialog
          order={order}
          onClose={() => {
            setWithdrawing(false);
          }}
          onReload={() => {
            void query.refetch();
          }}
          onWithdrawn={(draft) => {
            saved(draft);
            void refreshApprovals();
            setWithdrawing(false);
            setNotice('Withdrawn. It is a draft again.');
          }}
        />
      )}
      {approving && (
        <ApproveDialog
          order={order}
          onClose={() => {
            setApproving(false);
          }}
          onReload={() => {
            void query.refetch();
          }}
          onApproved={(decided) => {
            saved(decided);
            void refreshApprovals();
            setApproving(false);
            setNotice(
              decided.status === 'APPROVED' ? 'Approved.' : 'Step approved. The next step waits.',
            );
          }}
        />
      )}
      {deleting && (
        <DeleteDraftDialog
          order={order}
          onClose={() => {
            setDeleting(false);
          }}
          onReload={() => {
            void query.refetch();
          }}
        />
      )}
    </>
  );
}

/** The vendor as the order was submitted (ADR-0005): name, contact and payment terms. */
function VendorAsSubmitted({ snapshot }: { snapshot: NonNullable<Order['vendorSnapshot']> }) {
  return (
    <div role="group" aria-label="Vendor as submitted" className={styles.snapshot}>
      <span>
        {snapshot.name} <span className={styles.badge}>as submitted</span>
      </span>
      <span>
        {snapshot.contactName} · {snapshot.contactEmail}
        {snapshot.contactPhone !== null && ` · ${snapshot.contactPhone}`}
      </span>
      <span>{formatPaymentTerms(snapshot.paymentTerms)}</span>
    </div>
  );
}
