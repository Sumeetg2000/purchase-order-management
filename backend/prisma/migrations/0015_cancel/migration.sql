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

-- ---------------------------------------------------------------------------------------
-- Part 2: the guard (D9-D11) and the commit-time check's cancelled branch.
-- ---------------------------------------------------------------------------------------

-- D9: a rejected or cancelled order never changes, whatever the column (both are final).
-- D10: the cancel record is written only with a change to CANCELLED; the cancel
-- (APPROVED to CANCELLED) changes nothing but the status, the version (by one), updated_at
-- and the record; cancelled_at is the database clock. From any other state the
-- transitions table refuses the change (PO009), as before.
-- D11: the cancel is by the acting user, never the order's owner (as a step decision).
-- Named to sort first among the BEFORE UPDATE triggers, so D9 answers before any other.
CREATE FUNCTION purchase_orders_cancel_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  record_columns CONSTANT text[] := ARRAY['cancelled_by', 'cancelled_at', 'cancel_reason'];
  actor uuid;
BEGIN
  IF OLD.status IN ('REJECTED', 'CANCELLED') THEN
    RAISE EXCEPTION 'ORDER_CLOSED' USING
      ERRCODE = 'PO018', DETAIL = format('order %s is %s: it never changes', OLD.id, OLD.status);
  END IF;
  IF NEW.status IS DISTINCT FROM 'CANCELLED' THEN
    IF (NEW.cancelled_by, NEW.cancelled_at, NEW.cancel_reason)
       IS DISTINCT FROM (OLD.cancelled_by, OLD.cancelled_at, OLD.cancel_reason) THEN
      RAISE EXCEPTION 'ORDER_CANCEL_REFUSED' USING
        ERRCODE = 'PO019',
        DETAIL = format('order %s: the cancel record is written only by the cancel', OLD.id);
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'APPROVED' THEN
    RETURN NEW;
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version + 1
     OR to_jsonb(NEW) - record_columns - ARRAY['status', 'version', 'updated_at']
        IS DISTINCT FROM to_jsonb(OLD) - record_columns - ARRAY['status', 'version', 'updated_at'] THEN
    RAISE EXCEPTION 'ORDER_CANCEL_REFUSED' USING
      ERRCODE = 'PO019',
      DETAIL = format('order %s: the cancel changes only its status, version and record', OLD.id);
  END IF;
  -- A missing record is left to purchase_orders_cancel_matches_status.
  IF NEW.cancelled_by IS NOT NULL THEN
    actor := nullif(current_setting('app.actor_user_id', true), '')::uuid;
    IF current_setting('app.actor_type', true) IS DISTINCT FROM 'USER'
       OR NEW.cancelled_by IS DISTINCT FROM actor OR NEW.cancelled_by = OLD.owner_id THEN
      RAISE EXCEPTION 'SELF_DECISION_REFUSED' USING
        ERRCODE = 'PO016',
        DETAIL = format('order %s: cancelled by the acting user, never the owner', OLD.id);
    END IF;
  END IF;
  NEW.cancelled_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER purchase_orders_cancel_guard
  BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION purchase_orders_cancel_guard();

REVOKE ALL ON FUNCTION purchase_orders_cancel_guard() FROM PUBLIC;

-- D1's cancelled branch (research R2): a cancelled order's round stays closed as it was
-- approved, and approved_at its close. Every status is now reachable, so the "not
-- reachable yet" fallback goes. Grants on the function are kept by CREATE OR REPLACE.
CREATE OR REPLACE FUNCTION approval_inconsistency(checked uuid) RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  o record;
  r record;
  pattern text;
BEGIN
  SELECT id, status, total, current_round, submitted_at, approved_at INTO o
    FROM public.purchase_orders WHERE id = checked;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.approval_rounds
              WHERE order_id = o.id AND round > coalesce(o.current_round, 0)) THEN
    RETURN 'a round after the current one';
  END IF;
  IF EXISTS (SELECT 1 FROM public.approval_rounds er
              WHERE er.order_id = o.id AND er.round < o.current_round
                AND (er.outcome IS DISTINCT FROM 'WITHDRAWN'
                     OR EXISTS (SELECT 1 FROM public.approval_steps s
                                 WHERE s.order_id = o.id AND s.round = er.round
                                   AND s.state <> 'VOIDED'))) THEN
    RETURN 'an earlier round is not withdrawn with every step voided';
  END IF;
  IF o.current_round IS NULL THEN
    IF o.status <> 'DRAFT' THEN
      RETURN format('%s with no approval round', o.status);
    END IF;
    RETURN NULL;
  END IF;
  SELECT round, policy_version, total, submitted_at, outcome, closed_at INTO r
    FROM public.approval_rounds WHERE order_id = o.id AND round = o.current_round;
  -- One letter per step in step order: O(pen), A(pproved), R(ejected), V(oided).
  SELECT coalesce(string_agg(left(state, 1), '' ORDER BY step), '') INTO pattern
    FROM public.approval_steps WHERE order_id = o.id AND round = r.round;
  IF o.status = 'DRAFT' THEN
    IF r.outcome IS DISTINCT FROM 'WITHDRAWN' OR pattern !~ '^V*$' THEN
      RETURN 'a draft whose last round is not withdrawn with every step voided';
    END IF;
    RETURN NULL;
  END IF;
  IF r.total <> o.total THEN
    RETURN format('round total %s, order total %s', r.total, o.total);
  END IF;
  IF o.submitted_at IS DISTINCT FROM r.submitted_at THEN
    RETURN 'submitted_at is not the round''s';
  END IF;
  IF EXISTS (
    WITH expected AS (
      SELECT row_number() OVER (ORDER BY tier) AS step, tier, threshold
        FROM public.approval_policy_tiers
       WHERE policy_version = r.policy_version AND threshold < r.total
    ), actual AS (
      SELECT step, tier, threshold FROM public.approval_steps
       WHERE order_id = o.id AND round = r.round
    )
    SELECT 1 FROM expected e FULL JOIN actual a ON a.step = e.step
     WHERE e.tier IS DISTINCT FROM a.tier OR e.threshold IS DISTINCT FROM a.threshold
  ) THEN
    RETURN 'the steps are not one per tier the total exceeds';
  END IF;
  IF o.status = 'PENDING_APPROVAL' THEN
    IF r.outcome IS NOT NULL OR pattern !~ '^A*O+$' THEN
      RETURN format('pending with round %s, steps %s', coalesce(r.outcome, 'open'), pattern);
    END IF;
  ELSIF o.status IN ('APPROVED', 'CANCELLED') THEN
    -- A cancelled order keeps the round that approved it (slice 5): cancel is no decision.
    IF NOT ((r.outcome = 'AUTO_APPROVED' AND pattern = '')
            OR (r.outcome = 'APPROVED' AND pattern ~ '^A+$')) THEN
      RETURN format('%s with round %s, steps %s', lower(o.status), coalesce(r.outcome, 'open'),
                    pattern);
    END IF;
    IF o.approved_at IS DISTINCT FROM r.closed_at THEN
      RETURN 'approved_at is not the round''s close';
    END IF;
  ELSIF o.status = 'REJECTED' THEN
    IF r.outcome IS DISTINCT FROM 'REJECTED' OR pattern !~ '^A*RV*$' THEN
      RETURN format('rejected with round %s, steps %s', coalesce(r.outcome, 'open'), pattern);
    END IF;
  END IF;
  RETURN NULL;
END
$$;
