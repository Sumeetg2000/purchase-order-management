-- Submission, routing and approval decisions (specs/005-submit-approve/data-model.md,
-- research R1–R4, ADR-0001, ADR-0002). Every number and list below is a constant in
-- packages/contracts/src/approvals.ts; tests/integration/order-constants.test.ts pins each
-- copy. Runs as po_owner.

-- ---------------------------------------------------------------------------------------
-- Part 1: tables, columns, grants, indexes, transitions and the seeded policy.
-- ---------------------------------------------------------------------------------------

-- Immutable policy versions (research R1): the highest version is current.
CREATE TABLE approval_policies (
  version integer PRIMARY KEY
    CONSTRAINT approval_policies_version_positive CHECK (version >= 1),
  effective_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE approval_policy_tiers (
  policy_version integer NOT NULL REFERENCES approval_policies (version),
  tier smallint NOT NULL
    CONSTRAINT approval_policy_tiers_tier_positive CHECK (tier >= 1),
  threshold numeric(22, 4) NOT NULL
    CONSTRAINT approval_policy_tiers_threshold_positive CHECK (threshold > 0),
  PRIMARY KEY (policy_version, tier)
);

-- One row per submission (research R2, R4).
CREATE TABLE approval_rounds (
  order_id uuid NOT NULL REFERENCES purchase_orders (id) ON DELETE CASCADE,
  round smallint NOT NULL
    CONSTRAINT approval_rounds_round_positive CHECK (round >= 1),
  policy_version integer NOT NULL REFERENCES approval_policies (version),
  total numeric(22, 4) NOT NULL
    CONSTRAINT approval_rounds_total_nonnegative CHECK (total >= 0),
  -- VendorOrderSnapshot, read whole and parsed by the contracts' schema.
  vendor_snapshot jsonb NOT NULL
    CONSTRAINT approval_rounds_vendor_snapshot_shape CHECK (
      jsonb_typeof(vendor_snapshot) = 'object'
      AND vendor_snapshot ?& ARRAY['id', 'name', 'contactName', 'contactEmail', 'contactPhone',
                                   'paymentTerms']),
  submitted_by uuid NOT NULL REFERENCES users (id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  -- APPROVAL_ROUND_OUTCOMES; null while the round is open.
  outcome text
    CONSTRAINT approval_rounds_outcome_valid
      CHECK (outcome IN ('AUTO_APPROVED', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  closed_at timestamptz,
  -- DECISION_REASON_MAX, trimmed (the API trims; line breaks are allowed).
  withdraw_reason text
    CONSTRAINT approval_rounds_withdraw_reason_valid CHECK (
      withdraw_reason = btrim(withdraw_reason) AND char_length(withdraw_reason) BETWEEN 1 AND 500),
  PRIMARY KEY (order_id, round),
  CONSTRAINT approval_rounds_closed_matches_outcome CHECK ((outcome IS NULL) = (closed_at IS NULL)),
  CONSTRAINT approval_rounds_withdraw_reason_matches_outcome
    CHECK ((outcome IS NOT DISTINCT FROM 'WITHDRAWN') = (withdraw_reason IS NOT NULL))
);

-- One row per tier step of a round (research R2).
CREATE TABLE approval_steps (
  order_id uuid NOT NULL,
  round smallint NOT NULL,
  step smallint NOT NULL
    CONSTRAINT approval_steps_step_positive CHECK (step >= 1),
  tier smallint NOT NULL
    CONSTRAINT approval_steps_tier_positive CHECK (tier >= 1),
  threshold numeric(22, 4) NOT NULL
    CONSTRAINT approval_steps_threshold_positive CHECK (threshold > 0),
  -- APPROVAL_STEP_STATES.
  state text NOT NULL DEFAULT 'OPEN'
    CONSTRAINT approval_steps_state_valid CHECK (state IN ('OPEN', 'APPROVED', 'REJECTED', 'VOIDED')),
  decided_by uuid REFERENCES users (id),
  decided_at timestamptz,
  decided_version integer
    CONSTRAINT approval_steps_decided_version_positive CHECK (decided_version >= 1),
  reason text
    CONSTRAINT approval_steps_reason_valid CHECK (
      reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 500),
  voided_at timestamptz,
  PRIMARY KEY (order_id, round, step),
  FOREIGN KEY (order_id, round) REFERENCES approval_rounds (order_id, round) ON DELETE CASCADE,
  -- A decision is the three decided_* columns together; a void keeps an earlier approval.
  CONSTRAINT approval_steps_state_shape CHECK (
    ((decided_by IS NULL) = (decided_at IS NULL) AND (decided_by IS NULL) = (decided_version IS NULL))
    AND CASE state
      WHEN 'OPEN' THEN decided_by IS NULL AND reason IS NULL AND voided_at IS NULL
      WHEN 'APPROVED' THEN decided_by IS NOT NULL AND reason IS NULL AND voided_at IS NULL
      WHEN 'REJECTED' THEN decided_by IS NOT NULL AND reason IS NOT NULL AND voided_at IS NULL
      WHEN 'VOIDED' THEN voided_at IS NOT NULL AND reason IS NULL
    END)
);

-- The submission columns (research R4). submitted_at is the current round's, for the
-- approval queue's index; approved_at starts the outstanding report's age (ADR-0015).
ALTER TABLE purchase_orders
  ADD COLUMN current_round smallint
    CONSTRAINT purchase_orders_current_round_positive CHECK (current_round >= 1),
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN approved_at timestamptz,
  ADD CONSTRAINT purchase_orders_submitted_matches_status
    CHECK ((status = 'DRAFT') = (submitted_at IS NULL)),
  ADD CONSTRAINT purchase_orders_approved_matches_status
    CHECK ((status IN ('APPROVED', 'CANCELLED')) = (approved_at IS NOT NULL)),
  ADD CONSTRAINT purchase_orders_current_round_fkey
    FOREIGN KEY (id, current_round) REFERENCES approval_rounds (order_id, round)
    DEFERRABLE INITIALLY DEFERRED;

-- ORDER_TRANSITIONS: T4, T5, T7, T8, T9 (ADR-0001). T6 isn't a status change; cancel is
-- slice 5's.
INSERT INTO order_status_transitions (from_status, to_status) VALUES
  ('DRAFT', 'APPROVED'),
  ('DRAFT', 'PENDING_APPROVAL'),
  ('PENDING_APPROVAL', 'APPROVED'),
  ('PENDING_APPROVAL', 'REJECTED'),
  ('PENDING_APPROVAL', 'DRAFT');

-- The approval queue (research R7): only pending orders, owner included for the
-- own-order exclusion.
CREATE INDEX purchase_orders_pending_submitted_idx
  ON purchase_orders (submitted_at, id) INCLUDE (owner_id)
  WHERE status = 'PENDING_APPROVAL';
CREATE INDEX purchase_orders_pending_vendor_submitted_idx
  ON purchase_orders (vendor_id, submitted_at, id) INCLUDE (owner_id)
  WHERE status = 'PENDING_APPROVAL';
CREATE INDEX purchase_orders_pending_po_number_idx
  ON purchase_orders (po_number) INCLUDE (owner_id)
  WHERE status = 'PENDING_APPROVAL';

-- Foreign keys on users and the policy, so a key change never scans these tables.
CREATE INDEX approval_steps_decided_by_idx ON approval_steps (decided_by)
  WHERE decided_by IS NOT NULL;
CREATE INDEX approval_rounds_submitted_by_idx ON approval_rounds (submitted_by);
CREATE INDEX approval_rounds_policy_version_idx ON approval_rounds (policy_version);

CREATE TRIGGER require_actor_context
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON approval_policies
  FOR EACH STATEMENT EXECUTE FUNCTION require_actor_context();
CREATE TRIGGER require_actor_context
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON approval_policy_tiers
  FOR EACH STATEMENT EXECUTE FUNCTION require_actor_context();
CREATE TRIGGER require_actor_context
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON approval_rounds
  FOR EACH STATEMENT EXECUTE FUNCTION require_actor_context();
CREATE TRIGGER require_actor_context
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON approval_steps
  FOR EACH STATEMENT EXECUTE FUNCTION require_actor_context();

-- Policy rows: read only; written by set_approval_policy (part 2).
GRANT SELECT ON TABLE approval_policies, approval_policy_tiers TO po_app;

GRANT SELECT ON TABLE approval_rounds TO po_app;
GRANT INSERT (order_id, round, policy_version, total, vendor_snapshot, submitted_by)
  ON TABLE approval_rounds TO po_app;
GRANT UPDATE (outcome, closed_at, withdraw_reason) ON TABLE approval_rounds TO po_app;

GRANT SELECT ON TABLE approval_steps TO po_app;
GRANT INSERT (order_id, round, step, tier, threshold) ON TABLE approval_steps TO po_app;
GRANT UPDATE (state, decided_by, decided_at, decided_version, reason, voided_at)
  ON TABLE approval_steps TO po_app;

GRANT UPDATE (status, current_round, submitted_at, approved_at) ON TABLE purchase_orders TO po_app;

-- The seeded policy, APPROVAL_POLICY_SEED_TIERS (ADR-0002). Migration data, like the
-- transition rows: no actor changes a policy here, so no audit entry is written (research
-- R1); every later policy:set is audited. The tables require an actor context.
DO $$
BEGIN
  PERFORM set_config('app.actor_txid', txid_current()::text, true);
  PERFORM set_config('app.actor_type', 'SYSTEM', true);
  INSERT INTO approval_policies (version) VALUES (1);
  INSERT INTO approval_policy_tiers (policy_version, tier, threshold) VALUES (1, 1, 100000.0000);
  PERFORM set_config('app.actor_type', '', true);
  PERFORM set_config('app.actor_txid', '', true);
END
$$;

-- ---------------------------------------------------------------------------------------
-- Part 2: what the database refuses (research R1, R2, R4; D1–D8). Custom SQLSTATEs, mapped
-- by code in backend/src/db/errors.ts; each means the service let something through:
--   PO012 APPROVAL_STEP_REFUSED          a step inserted, moved or deleted out of turn
--   PO013 APPROVAL_ROUND_REFUSED         a round inserted, changed or deleted out of turn
--   PO014 ORDER_APPROVAL_INCONSISTENT    at commit: status, round, chain or dates disagree
--   PO015 ORDER_SUBMISSION_FIELD_LOCKED  vendor or submission columns outside a transition
--   PO016 SELF_DECISION_REFUSED          a step decided by the owner, or not by the actor
--   PO017 APPROVAL_POLICY_IMMUTABLE      a policy row changed, or an invalid or non-operator write
-- ---------------------------------------------------------------------------------------

-- The policy's only write path (research R1). SECURITY DEFINER: it inserts as po_owner;
-- po_app holds EXECUTE but no INSERT. Refuses unless the transaction's actor is OPERATOR,
-- which only the operator CLI sets. Returns the current version, new or unchanged.
CREATE FUNCTION set_approval_policy(thresholds numeric[]) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  current_version integer;
  current_tiers numeric[];
  i integer;
BEGIN
  IF current_setting('app.actor_type', true) IS DISTINCT FROM 'OPERATOR' THEN
    RAISE EXCEPTION 'APPROVAL_POLICY_IMMUTABLE' USING
      ERRCODE = 'PO017', DETAIL = 'only the operator CLI sets the approval policy';
  END IF;
  IF thresholds IS NULL OR cardinality(thresholds) = 0 THEN
    RAISE EXCEPTION 'APPROVAL_POLICY_IMMUTABLE' USING
      ERRCODE = 'PO017', DETAIL = 'a policy needs at least one tier';
  END IF;
  FOR i IN 1 .. cardinality(thresholds) LOOP
    IF thresholds[i] IS NULL OR thresholds[i] <= 0 OR thresholds[i] <> round(thresholds[i], 4)
       OR thresholds[i] > 999999999999999999.9999
       OR (i > 1 AND thresholds[i] <= thresholds[i - 1]) THEN
      RAISE EXCEPTION 'APPROVAL_POLICY_IMMUTABLE' USING
        ERRCODE = 'PO017',
        DETAIL = format('tier %s: thresholds are > 0, at most 4 decimal places, increasing', i);
    END IF;
  END LOOP;
  -- One writer at a time, so two concurrent sets can't both read the same version.
  PERFORM pg_advisory_xact_lock(hashtext('approval_policies'));
  SELECT max(version) INTO current_version FROM public.approval_policies;
  SELECT array_agg(threshold ORDER BY tier) INTO current_tiers
    FROM public.approval_policy_tiers WHERE policy_version = current_version;
  IF current_tiers = thresholds THEN
    RETURN current_version;
  END IF;
  INSERT INTO public.approval_policies (version) VALUES (current_version + 1);
  INSERT INTO public.approval_policy_tiers (policy_version, tier, threshold)
  SELECT current_version + 1, t.tier, t.threshold
    FROM unnest(thresholds) WITH ORDINALITY AS t(threshold, tier);
  RETURN current_version + 1;
END
$$;

CREATE FUNCTION approval_policy_immutable() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'APPROVAL_POLICY_IMMUTABLE' USING
    ERRCODE = 'PO017', DETAIL = format('%s rows never change; set a new version', TG_TABLE_NAME);
END
$$;

-- Why an order's status, rounds and steps disagree, or NULL when they agree (D1). The
-- expected chain is re-derived from the round's policy tiers and total, so routing is the
-- database's too. Used by the commit-time trigger below and by the reconciliation query.
CREATE FUNCTION approval_inconsistency(checked uuid) RETURNS text
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
  ELSIF o.status = 'APPROVED' THEN
    IF NOT ((r.outcome = 'AUTO_APPROVED' AND pattern = '')
            OR (r.outcome = 'APPROVED' AND pattern ~ '^A+$')) THEN
      RETURN format('approved with round %s, steps %s', coalesce(r.outcome, 'open'), pattern);
    END IF;
    IF o.approved_at IS DISTINCT FROM r.closed_at THEN
      RETURN 'approved_at is not the round''s close';
    END IF;
  ELSIF o.status = 'REJECTED' THEN
    IF r.outcome IS DISTINCT FROM 'REJECTED' OR pattern !~ '^A*RV*$' THEN
      RETURN format('rejected with round %s, steps %s', coalesce(r.outcome, 'open'), pattern);
    END IF;
  ELSE
    RETURN format('%s is not reachable yet', o.status);
  END IF;
  RETURN NULL;
END
$$;

-- D1 at commit: one check per changed row of the three tables (at most 2 + tier count
-- per command), in whatever order the command wrote them. Two functions: plpgsql resolves
-- NEW's fields against the firing table (orders have id, rounds and steps order_id). They
-- run as po_owner (SECURITY DEFINER), so po_app needs no EXECUTE on the check, as slice 3's
-- commit-time line checks.
CREATE FUNCTION order_approval_check(checked uuid) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  problem text := public.approval_inconsistency(checked);
BEGIN
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'ORDER_APPROVAL_INCONSISTENT' USING
      ERRCODE = 'PO014', DETAIL = format('order %s: %s', checked, problem);
  END IF;
END
$$;

CREATE FUNCTION purchase_orders_approval_consistent() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM public.order_approval_check(NEW.id);
  RETURN NULL;
END
$$;

CREATE FUNCTION approval_rows_consistent() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM public.order_approval_check(NEW.order_id);
  RETURN NULL;
END
$$;

-- D4, D6, D7: a round is inserted only as a draft's next one, open, under the current
-- policy, by its owner; it closes once, AUTO_APPROVED only as SYSTEM; nothing else changes;
-- it is deleted only with its order.
CREATE FUNCTION approval_rounds_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  o record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.purchase_orders WHERE id = OLD.order_id) THEN
      RAISE EXCEPTION 'APPROVAL_ROUND_REFUSED' USING
        ERRCODE = 'PO013', DETAIL = format('order %s: a round is kept with its order', OLD.order_id);
    END IF;
    RETURN OLD;
  END IF;
  SELECT status, owner_id, total, current_round INTO o
    FROM public.purchase_orders WHERE id = NEW.order_id;
  IF TG_OP = 'INSERT' THEN
    IF o.status IS DISTINCT FROM 'DRAFT'
       OR NEW.round <> coalesce(o.current_round, 0) + 1
       OR NEW.outcome IS NOT NULL OR NEW.withdraw_reason IS NOT NULL
       OR NEW.submitted_by IS DISTINCT FROM o.owner_id
       OR NEW.policy_version <> (SELECT max(version) FROM public.approval_policies) THEN
      RAISE EXCEPTION 'APPROVAL_ROUND_REFUSED' USING
        ERRCODE = 'PO013',
        DETAIL = format('order %s: a round opens only on a draft, as its next round, by its '
                        'owner, under the current policy', NEW.order_id);
    END IF;
    NEW.submitted_at := now();
    NEW.closed_at := NULL;
    RETURN NEW;
  END IF;
  IF OLD.outcome IS NOT NULL
     OR NEW.outcome IS NULL
     OR (NEW.order_id, NEW.round, NEW.policy_version, NEW.total, NEW.vendor_snapshot,
         NEW.submitted_by, NEW.submitted_at)
        IS DISTINCT FROM (OLD.order_id, OLD.round, OLD.policy_version, OLD.total,
                          OLD.vendor_snapshot, OLD.submitted_by, OLD.submitted_at) THEN
    RAISE EXCEPTION 'APPROVAL_ROUND_REFUSED' USING
      ERRCODE = 'PO013',
      DETAIL = format('order %s round %s: a round only closes, once', OLD.order_id, OLD.round);
  END IF;
  IF NEW.outcome = 'AUTO_APPROVED'
     AND current_setting('app.actor_type', true) IS DISTINCT FROM 'SYSTEM' THEN
    RAISE EXCEPTION 'APPROVAL_ROUND_REFUSED' USING
      ERRCODE = 'PO013', DETAIL = 'only SYSTEM records an auto-approval';
  END IF;
  NEW.closed_at := now();
  RETURN NEW;
END
$$;

-- D2, D4, D5, D7: steps are inserted open with their round; a decision is on the lowest
-- open step of the current round of a pending order, by the acting user, never the owner,
-- against the order's version; voiding keeps an approval; nothing changes once the round
-- closes; a step is deleted only with its order.
CREATE FUNCTION approval_steps_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  o record;
  round_outcome text;
  actor uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.purchase_orders WHERE id = OLD.order_id) THEN
      RAISE EXCEPTION 'APPROVAL_STEP_REFUSED' USING
        ERRCODE = 'PO012', DETAIL = format('order %s: a step is kept with its order', OLD.order_id);
    END IF;
    RETURN OLD;
  END IF;
  SELECT status, owner_id, version, current_round INTO o
    FROM public.purchase_orders WHERE id = NEW.order_id;
  SELECT outcome INTO round_outcome
    FROM public.approval_rounds WHERE order_id = NEW.order_id AND round = NEW.round;
  IF TG_OP = 'INSERT' THEN
    IF o.status IS DISTINCT FROM 'DRAFT' OR NEW.round <> coalesce(o.current_round, 0) + 1
       OR round_outcome IS NOT NULL OR NEW.state <> 'OPEN' THEN
      RAISE EXCEPTION 'APPROVAL_STEP_REFUSED' USING
        ERRCODE = 'PO012',
        DETAIL = format('order %s: steps are inserted open, with the draft''s next round',
                        NEW.order_id);
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.order_id, NEW.round, NEW.step, NEW.tier, NEW.threshold)
     IS DISTINCT FROM (OLD.order_id, OLD.round, OLD.step, OLD.tier, OLD.threshold)
     OR round_outcome IS NOT NULL
     OR o.status IS DISTINCT FROM 'PENDING_APPROVAL' OR NEW.round <> o.current_round
     OR NEW.state = OLD.state THEN
    RAISE EXCEPTION 'APPROVAL_STEP_REFUSED' USING
      ERRCODE = 'PO012',
      DETAIL = format('order %s step %s.%s: only a state move on the open round of a pending '
                      'order', OLD.order_id, OLD.round, OLD.step);
  END IF;
  IF OLD.state = 'OPEN' AND NEW.state IN ('APPROVED', 'REJECTED') THEN
    IF EXISTS (SELECT 1 FROM public.approval_steps
                WHERE order_id = NEW.order_id AND round = NEW.round AND step < NEW.step
                  AND state = 'OPEN') THEN
      RAISE EXCEPTION 'APPROVAL_STEP_REFUSED' USING
        ERRCODE = 'PO012', DETAIL = format('order %s: an earlier step is still open', NEW.order_id);
    END IF;
    actor := nullif(current_setting('app.actor_user_id', true), '')::uuid;
    IF current_setting('app.actor_type', true) IS DISTINCT FROM 'USER'
       OR NEW.decided_by IS DISTINCT FROM actor OR NEW.decided_by = o.owner_id THEN
      RAISE EXCEPTION 'SELF_DECISION_REFUSED' USING
        ERRCODE = 'PO016',
        DETAIL = format('order %s: decided by the acting user, never the owner', NEW.order_id);
    END IF;
    IF NEW.decided_version IS DISTINCT FROM o.version THEN
      RAISE EXCEPTION 'APPROVAL_STEP_REFUSED' USING
        ERRCODE = 'PO012',
        DETAIL = format('order %s: decided against version %s, not %s', NEW.order_id,
                        NEW.decided_version, o.version);
    END IF;
    NEW.decided_at := now();
    RETURN NEW;
  END IF;
  IF NEW.state = 'VOIDED' AND OLD.state IN ('OPEN', 'APPROVED')
     AND (NEW.decided_by, NEW.decided_at, NEW.decided_version, NEW.reason)
         IS NOT DISTINCT FROM (OLD.decided_by, OLD.decided_at, OLD.decided_version, OLD.reason) THEN
    NEW.voided_at := now();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'APPROVAL_STEP_REFUSED' USING
    ERRCODE = 'PO012',
    DETAIL = format('order %s step %s.%s: %s → %s is not a step move', OLD.order_id, OLD.round,
                    OLD.step, OLD.state, NEW.state);
END
$$;

-- D8: a submitted order keeps its vendor, and the submission columns move only with a
-- status change (the transition sets them; D1 checks their values at commit).
CREATE FUNCTION purchase_orders_submission_lock() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.vendor_id IS DISTINCT FROM OLD.vendor_id
     AND (OLD.status <> 'DRAFT' OR NEW.status <> 'DRAFT') THEN
    RAISE EXCEPTION 'ORDER_SUBMISSION_FIELD_LOCKED' USING
      ERRCODE = 'PO015', DETAIL = format('order %s is %s: its vendor is fixed', OLD.id, OLD.status);
  END IF;
  IF (NEW.current_round, NEW.submitted_at, NEW.approved_at)
     IS DISTINCT FROM (OLD.current_round, OLD.submitted_at, OLD.approved_at)
     AND NEW.status = OLD.status THEN
    RAISE EXCEPTION 'ORDER_SUBMISSION_FIELD_LOCKED' USING
      ERRCODE = 'PO015',
      DETAIL = format('order %s: the submission columns change only with its status', OLD.id);
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER approval_policies_immutable
  BEFORE UPDATE OR DELETE ON approval_policies
  FOR EACH ROW EXECUTE FUNCTION approval_policy_immutable();
CREATE TRIGGER approval_policy_tiers_immutable
  BEFORE UPDATE OR DELETE ON approval_policy_tiers
  FOR EACH ROW EXECUTE FUNCTION approval_policy_immutable();
CREATE TRIGGER approval_policies_no_truncate
  BEFORE TRUNCATE ON approval_policies
  FOR EACH STATEMENT EXECUTE FUNCTION approval_policy_immutable();
CREATE TRIGGER approval_policy_tiers_no_truncate
  BEFORE TRUNCATE ON approval_policy_tiers
  FOR EACH STATEMENT EXECUTE FUNCTION approval_policy_immutable();
CREATE TRIGGER approval_rounds_guard
  BEFORE INSERT OR UPDATE OR DELETE ON approval_rounds
  FOR EACH ROW EXECUTE FUNCTION approval_rounds_guard();
CREATE TRIGGER approval_steps_guard
  BEFORE INSERT OR UPDATE OR DELETE ON approval_steps
  FOR EACH ROW EXECUTE FUNCTION approval_steps_guard();
CREATE TRIGGER purchase_orders_submission_lock
  BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION purchase_orders_submission_lock();
CREATE CONSTRAINT TRIGGER purchase_orders_approval_consistent
  AFTER UPDATE ON purchase_orders DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION purchase_orders_approval_consistent();
CREATE CONSTRAINT TRIGGER approval_rounds_consistent
  AFTER INSERT OR UPDATE ON approval_rounds DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION approval_rows_consistent();
CREATE CONSTRAINT TRIGGER approval_steps_consistent
  AFTER INSERT OR UPDATE ON approval_steps DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION approval_rows_consistent();

REVOKE ALL ON FUNCTION set_approval_policy(numeric[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION approval_policy_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION approval_inconsistency(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION order_approval_check(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_orders_approval_consistent() FROM PUBLIC;
REVOKE ALL ON FUNCTION approval_rows_consistent() FROM PUBLIC;
REVOKE ALL ON FUNCTION approval_rounds_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION approval_steps_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_orders_submission_lock() FROM PUBLIC;
-- The CLI's write path, and the reconciliation's approval check (run as po_app).
GRANT EXECUTE ON FUNCTION set_approval_policy(numeric[]) TO po_app;
GRANT EXECUTE ON FUNCTION approval_inconsistency(uuid) TO po_app;
