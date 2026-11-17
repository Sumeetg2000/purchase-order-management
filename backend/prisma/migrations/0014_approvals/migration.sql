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
