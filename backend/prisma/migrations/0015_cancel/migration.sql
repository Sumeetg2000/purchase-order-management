-- Cancelling approved orders, and the remaining locks (specs/006-lock-cancel/data-model.md,
-- research R1–R2, ADR-0001 T10). The reason limit is DECISION_REASON_MAX and the
-- transition is in ORDER_TRANSITIONS (packages/contracts/src/approvals.ts);
-- tests/integration/order-constants.test.ts pins each copy. Runs as po_owner.

-- ---------------------------------------------------------------------------------------
-- Part 1: the cancel record, its checks, grants, index and transition.
-- ---------------------------------------------------------------------------------------

-- The cancel record (research R1): who, when and why, all set exactly when the order is
-- cancelled. cancelled_at is the database clock, set by the guard (part 2), so po_app
-- gets no grant on it.
ALTER TABLE purchase_orders
  ADD COLUMN cancelled_by uuid
    CONSTRAINT purchase_orders_cancelled_by_fkey REFERENCES users (id),
  ADD COLUMN cancelled_at timestamptz,
  -- DECISION_REASON_MAX, trimmed (the API trims; line breaks are allowed), as a withdrawal.
  ADD COLUMN cancel_reason text
    CONSTRAINT purchase_orders_cancel_reason_valid CHECK (
      cancel_reason = btrim(cancel_reason) AND char_length(cancel_reason) BETWEEN 1 AND 500),
  ADD CONSTRAINT purchase_orders_cancel_matches_status CHECK (
    (status = 'CANCELLED') = (cancelled_by IS NOT NULL)
    AND (status = 'CANCELLED') = (cancelled_at IS NOT NULL)
    AND (status = 'CANCELLED') = (cancel_reason IS NOT NULL));

GRANT UPDATE (cancelled_by, cancel_reason) ON TABLE purchase_orders TO po_app;

-- The canceller's foreign key, so a key change on users never scans orders (research R8).
-- Not a filter index: the Cancelled filter walks the status indexes.
CREATE INDEX purchase_orders_cancelled_by_idx ON purchase_orders (cancelled_by)
  WHERE cancelled_by IS NOT NULL;

-- ORDER_TRANSITIONS: T10 (ADR-0001).
INSERT INTO order_status_transitions (from_status, to_status) VALUES ('APPROVED', 'CANCELLED');
