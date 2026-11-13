-- Purchase orders and their lines, drafts only (data-model.md, ADR-0001, ADR-0003). Every
-- number and list below is a constant in packages/contracts/src/orders.ts;
-- tests/integration/order-constants.test.ts pins each copy. Runs as po_owner.
--
-- Ids come from the app (a UUIDv7, migration 0012), so no id has a default.

-- The Indian financial year (April to March) of a moment, in Asia/Kolkata
-- (PO_NUMBER_TIME_ZONE), as '2026-27'. Three months before the local time falls in the
-- FY's first calendar year. STABLE: the time-zone rules are data, not the function's.
CREATE FUNCTION po_financial_year(ts timestamptz) RETURNS text
LANGUAGE sql
STABLE STRICT PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
RETURN extract(year FROM (ts AT TIME ZONE 'Asia/Kolkata') - interval '3 months')::int::text
  || '-'
  || lpad(((extract(year FROM (ts AT TIME ZONE 'Asia/Kolkata') - interval '3 months')::int + 1)
           % 100)::text, 2, '0');

REVOKE ALL ON FUNCTION po_financial_year(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION po_financial_year(timestamptz) TO po_app;

-- One row per financial year: the last PO number given (research R2). Never deleted.
CREATE TABLE po_number_counters (
  fy text PRIMARY KEY
    CONSTRAINT po_number_counters_fy_format CHECK (fy ~ '^\d{4}-\d{2}$'),
  last_value bigint NOT NULL
    CONSTRAINT po_number_counters_last_value_positive CHECK (last_value >= 1)
);

CREATE TABLE purchase_orders (
  id uuid PRIMARY KEY,
  -- PO_NUMBER_PATTERN. NULL only inside the creating transaction (research R2). "C" so
  -- the unique btree serves the PO-number prefix filter, walked backwards.
  po_number text COLLATE "C"
    CONSTRAINT purchase_orders_po_number_format CHECK (po_number ~ '^PO-\d{4}-\d{2}-\d{6,}$'),
  owner_id uuid NOT NULL REFERENCES users (id),
  vendor_id uuid NOT NULL REFERENCES vendors (id),
  -- ORDER_STATUSES, in the same order.
  status text NOT NULL DEFAULT 'DRAFT'
    CONSTRAINT purchase_orders_status_valid
      CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED')),
  -- Derived (INV-2, INV-6): written only by recompute_orders.
  total numeric(22, 4) NOT NULL DEFAULT 0
    CONSTRAINT purchase_orders_total_nonnegative CHECK (total >= 0),
  open_line_count integer NOT NULL DEFAULT 0
    CONSTRAINT purchase_orders_open_line_count_nonnegative CHECK (open_line_count >= 0),
  version integer NOT NULL DEFAULT 1
    CONSTRAINT purchase_orders_version_positive CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_orders_po_number_key UNIQUE (po_number)
);

CREATE TABLE order_lines (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES purchase_orders (id) ON DELETE CASCADE,
  -- Display order, 0 to ORDER_LINES_MAX - 1.
  position integer NOT NULL
    CONSTRAINT order_lines_position_range CHECK (position BETWEEN 0 AND 499),
  -- LINE_DESCRIPTION_MAX code points (char_length counts them in UTF-8), trimmed, single
  -- line plain text: no control characters (research R9).
  description text NOT NULL
    CONSTRAINT order_lines_description_valid CHECK (
      description = btrim(description)
      AND char_length(description) BETWEEN 1 AND 500
      AND description !~ '[[:cntrl:]]'),
  -- LINE_QUANTITY_MAX.
  quantity integer NOT NULL
    CONSTRAINT order_lines_quantity_range CHECK (quantity BETWEEN 1 AND 1000000),
  -- UNIT_PRICE_MAX is the type's own maximum.
  unit_price numeric(13, 4) NOT NULL
    CONSTRAINT order_lines_unit_price_nonnegative CHECK (unit_price >= 0),
  -- INV-1 by construction.
  line_total numeric(22, 4) GENERATED ALWAYS AS (quantity * unit_price) STORED,
  -- INV-4. Written only by slice 6's receipt trigger.
  received_quantity integer NOT NULL DEFAULT 0
    CONSTRAINT order_lines_received_quantity_range CHECK (received_quantity BETWEEN 0 AND quantity),
  -- Deferred, so an edit can renumber its lines in one statement.
  CONSTRAINT order_lines_order_position_key UNIQUE (order_id, position)
    DEFERRABLE INITIALLY DEFERRED
);

-- Allowed status changes. Empty in this slice: slice 4 inserts the submit transitions.
CREATE TABLE order_status_transitions (
  from_status text NOT NULL,
  to_status text NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

-- Idempotent creates (research R5). status and response are NULL until the create
-- succeeds, in the same transaction. Purged after IDEMPOTENCY_KEY_TTL_HOURS.
CREATE TABLE idempotency_keys (
  user_id uuid NOT NULL REFERENCES users (id),
  operation text NOT NULL
    CONSTRAINT idempotency_keys_operation_valid CHECK (operation IN ('createOrder')),
  key uuid NOT NULL,
  request_hash bytea NOT NULL
    CONSTRAINT idempotency_keys_request_hash_sha256 CHECK (octet_length(request_hash) = 32),
  status smallint,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, operation, key)
);

CREATE INDEX idempotency_keys_created_at_idx ON idempotency_keys (created_at);

-- Order lists (research R7): one index per scope × filter, each ending in the list's sort
-- so a page walks the index and stops at its LIMIT.
CREATE INDEX purchase_orders_owner_created_idx
  ON purchase_orders (owner_id, created_at DESC, id DESC);
CREATE INDEX purchase_orders_owner_status_created_idx
  ON purchase_orders (owner_id, status, created_at DESC, id DESC);
CREATE INDEX purchase_orders_owner_vendor_created_idx
  ON purchase_orders (owner_id, vendor_id, created_at DESC, id DESC);
CREATE INDEX purchase_orders_created_idx
  ON purchase_orders (created_at DESC, id DESC);
CREATE INDEX purchase_orders_status_created_idx
  ON purchase_orders (status, created_at DESC, id DESC);
CREATE INDEX purchase_orders_vendor_created_idx
  ON purchase_orders (vendor_id, created_at DESC, id DESC);
CREATE INDEX purchase_orders_owner_po_number_idx
  ON purchase_orders (owner_id, po_number);

CREATE TRIGGER require_actor_context
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON purchase_orders
  FOR EACH STATEMENT EXECUTE FUNCTION require_actor_context();

CREATE TRIGGER require_actor_context
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON order_lines
  FOR EACH STATEMENT EXECUTE FUNCTION require_actor_context();

CREATE TRIGGER purchase_orders_set_updated_at
  BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- No privilege on the derived columns, status (slice 4 grants it), owner or timestamps.
GRANT SELECT, DELETE ON TABLE purchase_orders TO po_app;
GRANT INSERT (id, owner_id, vendor_id) ON TABLE purchase_orders TO po_app;
GRANT UPDATE (vendor_id, version, po_number) ON TABLE purchase_orders TO po_app;

-- No privilege on line_total (generated) or received_quantity (receipts, slice 6).
GRANT SELECT, DELETE ON TABLE order_lines TO po_app;
GRANT INSERT (id, order_id, position, description, quantity, unit_price)
  ON TABLE order_lines TO po_app;
GRANT UPDATE (position, description, quantity, unit_price) ON TABLE order_lines TO po_app;

GRANT SELECT, INSERT ON TABLE po_number_counters TO po_app;
GRANT UPDATE (last_value) ON TABLE po_number_counters TO po_app;

GRANT SELECT ON TABLE order_status_transitions TO po_app;

GRANT SELECT, INSERT ON TABLE idempotency_keys TO po_app;
GRANT UPDATE (status, response) ON TABLE idempotency_keys TO po_app;
GRANT SELECT, DELETE ON TABLE idempotency_keys TO po_maintenance;
