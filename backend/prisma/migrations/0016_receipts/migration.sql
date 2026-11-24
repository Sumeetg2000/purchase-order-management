-- Goods receipt (specs/007-goods-receipt/data-model.md, research R1–R4, R10). The limits
-- are LINE_QUANTITY_MAX and RECEIPT_NOTE_MAX, the time zone RECEIPT_TIME_ZONE, and the
-- operation IDEMPOTENT_OPERATIONS; tests/integration/order-constants.test.ts and
-- receipt-triggers.test.ts pin each copy. Runs as po_owner.

-- ---------------------------------------------------------------------------------------
-- Part 1: the receipts table, its checks, keys, indexes and grants (research R1, R10).
-- ---------------------------------------------------------------------------------------

-- The target of the receipts' composite foreign key: a receipt's order is its line's.
ALTER TABLE order_lines ADD CONSTRAINT order_lines_id_order_key UNIQUE (id, order_id);

-- One row per line per receipt command, never changed (D16, part 2). recorded_at is the
-- database clock, set by the insert trigger (part 2) whatever is sent; po_app has no
-- grant on it or on the id.
CREATE TABLE receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  line_id uuid NOT NULL,
  -- LINE_QUANTITY_MAX, as a line's quantity.
  quantity integer NOT NULL
    CONSTRAINT receipts_quantity_range CHECK (quantity BETWEEN 1 AND 1000000),
  -- The India receipt date; its rules are D14 and D17 (part 2).
  received_at date NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid NOT NULL CONSTRAINT receipts_recorded_by_fkey REFERENCES users (id),
  -- RECEIPT_NOTE_MAX code points, trimmed; absent is NULL. Plain text: no control
  -- character but line feed and carriage return (Unicode's Cc, spelled out as for line
  -- descriptions), the reason rule's character set.
  note text
    CONSTRAINT receipts_note_valid CHECK (
      note = btrim(note)
      AND char_length(note) BETWEEN 1 AND 500
      AND note !~ '[\u0001-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]'),
  CONSTRAINT receipts_line_fkey FOREIGN KEY (line_id, order_id)
    REFERENCES order_lines (id, order_id) ON DELETE RESTRICT
);

-- The receipt history page and the list badge's EXISTS; INV-3 and the line key's checks;
-- the recorder's foreign key (research R10).
CREATE INDEX receipts_order_recorded_idx ON receipts (order_id, recorded_at DESC, id DESC);
CREATE INDEX receipts_line_idx ON receipts (line_id);
CREATE INDEX receipts_recorded_by_idx ON receipts (recorded_by);

CREATE TRIGGER require_actor_context
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON receipts
  FOR EACH STATEMENT EXECUTE FUNCTION require_actor_context();

GRANT SELECT ON TABLE receipts TO po_app;
GRANT INSERT (order_id, line_id, quantity, received_at, recorded_by, note)
  ON TABLE receipts TO po_app;

-- IDEMPOTENT_OPERATIONS: receipts are idempotent like creates (research R7).
ALTER TABLE idempotency_keys
  DROP CONSTRAINT idempotency_keys_operation_valid,
  ADD CONSTRAINT idempotency_keys_operation_valid
    CHECK (operation IN ('createOrder', 'recordReceipt'));
