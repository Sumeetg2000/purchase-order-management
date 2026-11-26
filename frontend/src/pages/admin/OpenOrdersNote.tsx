import { openOrdersCounts, openOrdersNote, type OpenOrders } from '../orders/receipt-progress';

/**
 * A user's open orders, as the role and deactivate dialogs state them (slice 6, ADR-0016
 * 2026-11-24): the three counts, and what happens to them when any is above zero.
 */
export function OpenOrdersNote({ counts }: { counts: OpenOrders }) {
  const note = openOrdersNote(counts);
  return (
    <>
      <p>Open orders: {openOrdersCounts(counts)}</p>
      {note && <p>{note}</p>}
    </>
  );
}
