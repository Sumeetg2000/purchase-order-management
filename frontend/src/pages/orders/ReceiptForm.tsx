import { lineNumber, RECEIPT_NOTE_MAX, RECEIPT_TIME_ZONE } from '@po/contracts';
import { useId, useState } from 'react';
import { classes } from '../../styles/classes';
import controlsCss from '../../styles/controls.module.css';
import { ReceiptDialog, type ReceiptLinePlan } from './ReceiptDialog';
import type { Order } from './queries';
import css from './orders.module.css';

const controls = classes(controlsCss, 'button');
const styles = classes(css, 'lines', 'number', 'hint');

const INDIA_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: RECEIPT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** A moment's calendar date in India (`YYYY-MM-DD`): receipt dates are India dates. */
const indiaDate = (at: Date): string => INDIA_DATE.format(at);

export interface ReceiptFormProps {
  order: Order;
  onClose: () => void;
  onReload: () => void;
  onRecorded: () => void;
}

/**
 * Record receipt (contracts/ui.md): one quantity per line still to come (blank: not in
 * this delivery), the receipt date (today in India by default, from the approval date to
 * today) and an optional note. Continue opens the dialog, which says what the receipt does
 * and sends it.
 */
export function ReceiptForm({ order, onClose, onReload, onRecorded }: ReceiptFormProps) {
  const today = indiaDate(new Date());
  const approvedOn = order.approvedAt === null ? today : indiaDate(new Date(order.approvedAt));
  const open = order.lines
    .map((line, position) => ({ line, position }))
    .filter(({ line }) => line.outstandingQuantity > 0);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [receivedOn, setReceivedOn] = useState(today);
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [exceeding, setExceeding] = useState<ReadonlySet<string>>(new Set());
  const dateId = useId();
  const noteId = useId();

  const plan: ReceiptLinePlan[] = open.flatMap(({ line, position }) => {
    const quantity = Number(quantities[line.id] ?? '');
    return Number.isInteger(quantity) && quantity > 0
      ? [
          {
            lineId: line.id,
            position,
            quantity,
            receivedSoFar: line.receivedQuantity,
            outstandingAfter: line.outstandingQuantity - quantity,
          },
        ]
      : [];
  });
  const trimmedNote = note.trim();

  return (
    <>
      <form
        aria-label="Record receipt"
        onSubmit={(event) => {
          event.preventDefault();
          if (plan.length > 0) setConfirming(true);
        }}
      >
        <h2>Record receipt</h2>
        <p className={styles.hint}>
          Enter what arrived. Leave a line blank if it wasn't in this delivery.
        </p>
        <table className={styles.lines} aria-label="Lines to receive">
          <thead>
            <tr>
              <th scope="col">Line</th>
              <th scope="col">Outstanding</th>
              <th scope="col">Quantity received</th>
            </tr>
          </thead>
          <tbody>
            {open.map(({ line, position }) => {
              const label = `Line ${String(lineNumber(position))}, ${line.description}: quantity received (${String(line.outstandingQuantity)} outstanding)`;
              return (
                <tr key={line.id}>
                  <td>
                    Line {lineNumber(position)}: {line.description}
                  </td>
                  <td className={styles.number}>{line.outstandingQuantity}</td>
                  <td>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={line.outstandingQuantity}
                      step={1}
                      aria-label={label}
                      aria-invalid={exceeding.has(line.id) ? true : undefined}
                      value={quantities[line.id] ?? ''}
                      onChange={(event) => {
                        const value = event.target.value;
                        setQuantities((was) => ({ ...was, [line.id]: value }));
                      }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p>
          <label htmlFor={dateId}>Receipt date</label>{' '}
          <input
            id={dateId}
            type="date"
            min={approvedOn}
            max={today}
            required
            value={receivedOn}
            onChange={(event) => {
              setReceivedOn(event.target.value);
            }}
          />
        </p>
        <p>
          <label htmlFor={noteId}>Note (optional)</label>
          <textarea
            id={noteId}
            maxLength={RECEIPT_NOTE_MAX}
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        </p>
        <p>
          <button
            type="button"
            className={controls.button}
            disabled={plan.length === 0}
            onClick={() => {
              setConfirming(true);
            }}
          >
            Continue
          </button>{' '}
          <button type="button" className={controls.button} onClick={onClose}>
            Cancel
          </button>
        </p>
      </form>
      {confirming && (
        <ReceiptDialog
          order={order}
          plan={plan}
          body={{
            receivedOn,
            ...(trimmedNote === '' ? {} : { note: trimmedNote }),
            lines: plan.map(({ lineId, quantity }) => ({ lineId, quantity })),
          }}
          onClose={() => {
            setConfirming(false);
          }}
          onReload={onReload}
          onExceeded={(lineIds) => {
            setExceeding(new Set(lineIds));
          }}
          onRecorded={() => {
            setConfirming(false);
            onRecorded();
          }}
        />
      )}
    </>
  );
}
