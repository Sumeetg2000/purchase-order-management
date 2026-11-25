# ADR-0011: Goods receipts and cancelling orders that have received goods

- **Status:** Accepted · 2026-10-16 · amended 2026-10-20 (receipt fields and multi-line
  receipts moved or added here; receipt corrections **not adopted**) · amended 2026-11-24 (the receipt date is an India
  calendar date bounded by today and the approval date; one received-summary wording;
  **owner decision**; slice 6 spec) · amended 2026-11-25 (a receipt is a document with
  lines; the date is `received_on`; **owner decision**; slice 6 research R1)
- **Brief:** §3.5, §3.7 · Gap G26, Q10
- **Principles:** II, IV, VII

## Decision

### Receipts
- Each receipt records:
  - the line
  - the quantity (> 0)
  - `received_on` (named `received_at` until 2026-11-25): supplied by the user, a calendar date in Asia/Kolkata, not after today
    and not before the order's approval date, both taken as India dates (amended
    2026-11-24; tests inject the clock)
  - `recorded_at`: database clock, stored beside it; both appear in the audit entry and
    the timeline
  - the recording user
  - an optional note
- Over-receipt tolerance is zero [BRIEF §3.6].
- **One receipt command may cover several lines of one order**:
  `POST /api/orders/:id/receipts { receivedOn, note?, lines: [{ lineId, quantity }] }`, with
  `Idempotency-Key`.
  - It's all-or-nothing in one transaction. Lines are locked in id order.
  - If any line would exceed its outstanding quantity → `409 RECEIPT_EXCEEDS_OUTSTANDING`
    naming the line, and nothing is recorded.
  - Each line becomes its own immutable receipt row and its own `GOODS_RECEIPT_RECORDED`
    audit entry.
  - *Amended 2026-11-25 (**owner decision**, slice 6 research R1)*: the command records
    **one receipt document**, as a goods received note: a `goods_receipts` row holding
    the order, `received_on`, `recorded_at`, the recording user and the note once, and a
    `goods_receipt_lines` row per line (line, quantity; a receipt names a line once),
    written together in one statement. Composite keys tie every receipt line to the
    receipt's order and to a line of that order. Each receipt line still gets its own
    `GOODS_RECEIPT_RECORDED` entry, carrying the receipt's id. The history lists
    receipts, newest first, each with its lines.
  - The receipt confirmation dialog covers the whole command (ADR-0018).
- **Receipt corrections: not adopted** (owner decision 2026-10-20; ADR-0019). Receipts are
  append-only, with no reversal, negative receipt or edit.
  - **Consequence: a mistyped receipt is permanent.** If it fully receives a line, the
    order may become fully received, and then it can no longer be cancelled
    (`409 ORDER_FULLY_RECEIVED`).
  - **Mitigation**: the receipt confirmation dialog shows, per line, what is being
    received, what was received so far and what will be outstanding after. It warns
    explicitly when a line becomes fully received.

### Cancellation
- Cancelling is allowed with nothing received or part received. A fully received order →
  `409 ORDER_FULLY_RECEIVED`.
- Receipts are kept. A cancelled order leaves the outstanding report, and further receipts →
  `409 ORDER_NOT_RECEIVABLE`. Line outstanding remains `quantity − Σ receipts` (INV-4 is
  unchanged).
- `PO_CANCELLED` records the reason and the ordered and received quantity per line.
- Display: an order-level line summary counting complete and partly received lines
  ("Cancelled · 2 of 5 lines complete, 1 partly received"; a zero part is left out;
  amended 2026-11-24, the same wording as the cancel dialog, ADR-0018) and per-line units
  ("60 of 100 received").

## Alternatives
Cancel at any receipt state (allows a misleading "fully received but cancelled" record);
block once anything is received (partly received orders would stay outstanding forever
without a close-short feature).

## Tests
- Cancel with none, partial and full receipts. A receipt after cancel → 409. The
  cancel-vs-receive race.
- A multi-line receipt records every line or none: one line over → 409 naming it, and no
  rows are written.
- `received_on` after today or before the approval date (India dates) → 400; today and
  the approval date are accepted. Each line gets its own audit entry.
