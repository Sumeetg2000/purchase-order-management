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
  -- line plain text: no control character (research R9). The class is Unicode's Cc, spelled
  -- out, the same set the API refuses (\p{Cc}); [[:cntrl:]] would follow the database's
  -- locale (glibc also counts U+2028 and U+2029). U+0000 can't be stored in text at all.
  description text NOT NULL
    CONSTRAINT order_lines_description_valid CHECK (
      description = btrim(description)
      AND char_length(description) BETWEEN 1 AND 500
      AND description !~ '[\u0001-\u001f\u007f-\u009f]'),
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

-- ---------------------------------------------------------------------------------------
-- Part 2: derived values and order rules (research R3, R4). Custom SQLSTATEs (class PO),
-- mapped by code in backend/src/db/errors.ts; each means the service let through
-- something it should have refused:
--   PO005 DERIVED_VALUE_READ_ONLY          total or open_line_count written outside the recompute
--   PO006 ORDER_LINES_LOCKED               a line change on an order that isn't a draft
--   PO007 ORDER_WITHOUT_LINES              an order left without lines at commit
--   PO008 ORDER_FIELD_IMMUTABLE            po_number (once set), owner_id or created_at changed
--   PO009 ORDER_STATUS_TRANSITION_REFUSED  a status change not in order_status_transitions
--   PO010 ORDER_DELETE_REFUSED             a delete of an order that isn't a draft
--   PO011 PO_NUMBER_UNASSIGNED             an order committed without a PO number
-- ---------------------------------------------------------------------------------------

-- Recomputes the total (INV-2) and open-line count (INV-6) of the given orders in one
-- set-based statement. SECURITY DEFINER: it runs as po_owner, the only writer of the
-- derived columns, and nobody holds EXECUTE; the line triggers below call it. The
-- transaction-local flag po.recompute names this transaction while it writes, so the
-- guard lets exactly this write through. po.recompute_count counts the runs, for the
-- trigger-count tests. Orders that no longer exist (a cascade) are skipped.
CREATE FUNCTION recompute_orders(order_ids uuid[]) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF order_ids IS NULL OR cardinality(order_ids) = 0 THEN
    RETURN;
  END IF;
  PERFORM set_config('po.recompute', txid_current()::text, true);
  UPDATE public.purchase_orders o
     SET total = s.total, open_line_count = s.open_lines
    FROM (SELECT ids.id,
                 coalesce(sum(l.line_total), 0) AS total,
                 count(l.id) FILTER (WHERE l.received_quantity < l.quantity) AS open_lines
            FROM unnest(order_ids) AS ids(id)
            LEFT JOIN public.order_lines l ON l.order_id = ids.id
           GROUP BY ids.id) s
   WHERE o.id = s.id
     AND (o.total <> s.total OR o.open_line_count <> s.open_lines);
  PERFORM set_config('po.recompute', '', true);
  PERFORM set_config('po.recompute_count',
    (coalesce(nullif(current_setting('po.recompute_count', true), ''), '0')::int + 1)::text, true);
END
$$;

-- Lines change only on drafts. received_quantity alone is exempt: slice 6's
-- receipts change it on approved orders, through their own trigger. Called only from the
-- line triggers, which run as po_owner.
CREATE FUNCTION order_lines_require_drafts(order_ids uuid[]) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  locked uuid;
BEGIN
  SELECT id INTO locked FROM public.purchase_orders
   WHERE id = ANY(order_ids) AND status <> 'DRAFT' LIMIT 1;
  IF locked IS NOT NULL THEN
    RAISE EXCEPTION 'ORDER_LINES_LOCKED' USING
      ERRCODE = 'PO006', DETAIL = format('order %s is not a draft', locked);
  END IF;
END
$$;

-- One trigger per event: PostgreSQL allows transition tables only on single-event
-- triggers. Each runs once per statement, whatever the number of lines (ADR-0003).
CREATE FUNCTION order_lines_after_insert() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT order_id) INTO ids FROM new_lines;
  PERFORM public.order_lines_require_drafts(ids);
  PERFORM public.recompute_orders(ids);
  RETURN NULL;
END
$$;

CREATE FUNCTION order_lines_after_update() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  edited uuid[];
  recompute uuid[];
BEGIN
  -- Orders with a line changed in anything but received_quantity must be drafts.
  SELECT array_agg(DISTINCT x.order_id) INTO edited
    FROM old_lines o JOIN new_lines n ON n.id = o.id,
         LATERAL (VALUES (o.order_id), (n.order_id)) AS x(order_id)
   WHERE (o.order_id, o.position, o.description, o.quantity, o.unit_price)
         IS DISTINCT FROM (n.order_id, n.position, n.description, n.quantity, n.unit_price);
  PERFORM public.order_lines_require_drafts(edited);
  -- Only a change to what the derived values read recomputes them.
  SELECT array_agg(DISTINCT x.order_id) INTO recompute
    FROM old_lines o JOIN new_lines n ON n.id = o.id,
         LATERAL (VALUES (o.order_id), (n.order_id)) AS x(order_id)
   WHERE (o.order_id, o.quantity, o.unit_price, o.received_quantity)
         IS DISTINCT FROM (n.order_id, n.quantity, n.unit_price, n.received_quantity);
  PERFORM public.recompute_orders(recompute);
  RETURN NULL;
END
$$;

CREATE FUNCTION order_lines_after_delete() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT order_id) INTO ids FROM old_lines;
  PERFORM public.order_lines_require_drafts(ids);
  PERFORM public.recompute_orders(ids);
  RETURN NULL;
END
$$;

CREATE TRIGGER order_lines_recompute_ins
  AFTER INSERT ON order_lines REFERENCING NEW TABLE AS new_lines
  FOR EACH STATEMENT EXECUTE FUNCTION order_lines_after_insert();
CREATE TRIGGER order_lines_recompute_upd
  AFTER UPDATE ON order_lines REFERENCING OLD TABLE AS old_lines NEW TABLE AS new_lines
  FOR EACH STATEMENT EXECUTE FUNCTION order_lines_after_update();
CREATE TRIGGER order_lines_recompute_del
  AFTER DELETE ON order_lines REFERENCING OLD TABLE AS old_lines
  FOR EACH STATEMENT EXECUTE FUNCTION order_lines_after_delete();

-- The derived columns are written only by recompute_orders, whatever the role: a
-- privileged write gets a loud error, never a silent fix (Principle I). A new order
-- starts at zero; its lines set the values.
CREATE FUNCTION purchase_orders_derived_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.total <> 0 OR NEW.open_line_count <> 0 THEN
      RAISE EXCEPTION 'DERIVED_VALUE_READ_ONLY' USING
        ERRCODE = 'PO005', DETAIL = 'a new order starts with total 0 and no open lines';
    END IF;
  ELSIF (NEW.total IS DISTINCT FROM OLD.total
         OR NEW.open_line_count IS DISTINCT FROM OLD.open_line_count)
        AND current_setting('po.recompute', true) IS DISTINCT FROM txid_current()::text THEN
    RAISE EXCEPTION 'DERIVED_VALUE_READ_ONLY' USING
      ERRCODE = 'PO005',
      DETAIL = format('order %s: total and open_line_count are derived from its lines', OLD.id);
  END IF;
  RETURN NEW;
END
$$;

-- A PO number is set once, inside the creating transaction (NULL → a value), and never
-- changes after; nor do the owner or the creation time (ADR-0001).
CREATE FUNCTION purchase_orders_immutable() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (OLD.po_number IS NOT NULL AND NEW.po_number IS DISTINCT FROM OLD.po_number)
     OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'ORDER_FIELD_IMMUTABLE' USING
      ERRCODE = 'PO008',
      DETAIL = format('order %s: po_number, owner_id and created_at never change', OLD.id);
  END IF;
  RETURN NEW;
END
$$;

-- Status moves only along order_status_transitions (Principle II): empty in this slice.
CREATE FUNCTION purchase_orders_status_transition() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.order_status_transitions
                  WHERE from_status = OLD.status AND to_status = NEW.status) THEN
    RAISE EXCEPTION 'ORDER_STATUS_TRANSITION_REFUSED' USING
      ERRCODE = 'PO009',
      DETAIL = format('order %s: %s → %s is not a transition', OLD.id, OLD.status, NEW.status);
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION purchase_orders_delete_draft_only() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'ORDER_DELETE_REFUSED' USING
      ERRCODE = 'PO010', DETAIL = format('order %s is %s, not a draft', OLD.id, OLD.status);
  END IF;
  RETURN OLD;
END
$$;

-- INV-5 at commit: an order that still exists has a line. Deferred, so a create (order
-- before lines) and an edit that replaces every line both pass. One function per table:
-- plpgsql resolves OLD and NEW against the firing table's columns. The trigger functions
-- run as po_owner (SECURITY DEFINER), so po_app needs no EXECUTE on the shared check.
CREATE FUNCTION order_require_lines(checked uuid) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.purchase_orders WHERE id = checked)
     AND NOT EXISTS (SELECT 1 FROM public.order_lines WHERE order_id = checked) THEN
    RAISE EXCEPTION 'ORDER_WITHOUT_LINES' USING
      ERRCODE = 'PO007', DETAIL = format('order %s has no lines', checked);
  END IF;
END
$$;

CREATE FUNCTION purchase_orders_has_lines() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM public.order_require_lines(NEW.id);
  RETURN NULL;
END
$$;

CREATE FUNCTION order_lines_order_has_lines() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM public.order_require_lines(OLD.order_id);
  RETURN NULL;
END
$$;

-- Every committed order has its PO number (research R2).
CREATE FUNCTION purchase_orders_po_number_assigned() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.purchase_orders WHERE id = NEW.id AND po_number IS NULL) THEN
    RAISE EXCEPTION 'PO_NUMBER_UNASSIGNED' USING
      ERRCODE = 'PO011', DETAIL = format('order %s has no PO number', NEW.id);
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER purchase_orders_derived_guard
  BEFORE INSERT OR UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION purchase_orders_derived_guard();
CREATE TRIGGER purchase_orders_immutable
  BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION purchase_orders_immutable();
CREATE TRIGGER purchase_orders_status_transition
  BEFORE UPDATE OF status ON purchase_orders
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION purchase_orders_status_transition();
CREATE TRIGGER purchase_orders_delete_draft_only
  BEFORE DELETE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION purchase_orders_delete_draft_only();
CREATE CONSTRAINT TRIGGER purchase_orders_has_lines
  AFTER INSERT ON purchase_orders DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION purchase_orders_has_lines();
CREATE CONSTRAINT TRIGGER order_lines_order_has_lines
  AFTER DELETE ON order_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION order_lines_order_has_lines();
CREATE CONSTRAINT TRIGGER purchase_orders_po_number_assigned
  AFTER INSERT ON purchase_orders DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION purchase_orders_po_number_assigned();

-- Nobody calls these directly; triggers fire without EXECUTE.
REVOKE ALL ON FUNCTION recompute_orders(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION order_lines_require_drafts(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION order_lines_after_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION order_lines_after_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION order_lines_after_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_orders_derived_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_orders_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_orders_status_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_orders_delete_draft_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION order_require_lines(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_orders_has_lines() FROM PUBLIC;
REVOKE ALL ON FUNCTION order_lines_order_has_lines() FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_orders_po_number_assigned() FROM PUBLIC;
