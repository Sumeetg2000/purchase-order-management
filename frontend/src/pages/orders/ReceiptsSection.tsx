import { lineNumber } from '@po/contracts';
import { useId, useState } from 'react';
import { Pager } from '../../components/Pager';
import { formatDate, formatDateTime } from '../../format/date';
import { useQueryStates } from '../../hooks/useQueryStates';
import { classes } from '../../styles/classes';
import controlsCss from '../../styles/controls.module.css';
import { useOrderReceipt, useOrderReceipts, type Order } from './queries';
import css from './orders.module.css';

const controls = classes(controlsCss, 'button');
const styles = classes(css, 'lines', 'number', 'hint');

type ReceiptSummary = NonNullable<ReturnType<typeof useOrderReceipts>['data']>['items'][number];

/**
 * The order's receipts (contracts/ui.md): one row per receipt, newest first and paged;
 * a row expands to load that receipt's lines. An order with nothing received has no
 * receipt to ask for.
 */
export function ReceiptsSection({ order }: { order: Order }) {
  const [page, setPage] = useState(1);
  const anyReceived = order.receiptProgress !== 'NOT_RECEIVED';
  const states = useQueryStates(useOrderReceipts(order.id, page, { enabled: anyReceived }), {
    loadingLabel: 'Loading the receipts',
  });

  return (
    <section aria-label="Receipts">
      <h2>Receipts</h2>
      {!anyReceived ? (
        <p>No goods received yet.</p>
      ) : (
        (states.view ?? (
          <>
            {states.notice}
            <ul>
              {states.data.items.map((receipt) => (
                <ReceiptItem key={receipt.id} orderId={order.id} receipt={receipt} />
              ))}
            </ul>
            <Pager
              page={states.data.page}
              pageSize={states.data.pageSize}
              total={states.data.total}
              onPage={setPage}
            />
          </>
        ))
      )}
    </section>
  );
}

function ReceiptItem({ orderId, receipt }: { orderId: string; receipt: ReceiptSummary }) {
  const [open, setOpen] = useState(false);
  const linesId = useId();
  const lines = receipt.lineCount === 1 ? '1 line' : `${String(receipt.lineCount)} lines`;
  return (
    <li>
      <p>
        Received on {formatDate(receipt.receivedOn)} · {lines}
      </p>
      <p className={styles.hint}>
        Recorded by {receipt.recordedBy.name} on{' '}
        <time dateTime={receipt.recordedAt}>{formatDateTime(receipt.recordedAt)}</time>
      </p>
      {receipt.note !== null && <p>Note: {receipt.note}</p>}
      <button
        type="button"
        className={controls.button}
        aria-expanded={open}
        aria-controls={linesId}
        onClick={() => {
          setOpen((was) => !was);
        }}
      >
        {open ? 'Hide lines' : 'Show lines'}
      </button>
      <div id={linesId}>{open && <ReceiptLines orderId={orderId} receiptId={receipt.id} />}</div>
    </li>
  );
}

function ReceiptLines({ orderId, receiptId }: { orderId: string; receiptId: string }) {
  const states = useQueryStates(useOrderReceipt(orderId, receiptId), {
    loadingLabel: 'Loading the receipt lines',
  });
  if (states.view) return states.view;
  return (
    <table className={styles.lines} aria-label="Receipt lines">
      <thead>
        <tr>
          <th scope="col">Line</th>
          <th scope="col">Description</th>
          <th scope="col">Quantity</th>
        </tr>
      </thead>
      <tbody>
        {states.data.lines.map(({ line, quantity }) => (
          <tr key={line.id}>
            <td>Line {lineNumber(line.position)}</td>
            <td>{line.description}</td>
            <td className={styles.number}>{quantity}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
