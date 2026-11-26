-- Goods receipt (specs/007-goods-receipt/data-model.md, research R1–R4, R10). The limits
-- are LINE_QUANTITY_MAX and RECEIPT_NOTE_MAX, the time zone RECEIPT_TIME_ZONE, and the
-- operation IDEMPOTENT_OPERATIONS; tests/integration/order-constants.test.ts and
-- receipt-triggers.test.ts pin each copy. Runs as po_owner.

-- ---------------------------------------------------------------------------------------
-- Part 1: the receipt document (goods_receipts with its goods_receipt_lines), checks,
-- keys, indexes and grants (research R1, R10).
-- ---------------------------------------------------------------------------------------

-- The target of the receipt lines' line key: a receipt line's order is its line's.
ALTER TABLE order_lines ADD CONSTRAINT order_lines_id_order_key UNIQUE (id, order_id);

-- One row per receipt (a delivery), never changed (D16, part 2). recorded_at is the
-- database clock, set by the insert trigger (part 2) whatever is sent; po_app has no
-- grant on it or on the id. A receipt has at least one line, written in the same
-- statement (part 2).
CREATE TABLE goods_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL
    CONSTRAINT goods_receipts_order_fkey REFERENCES purchase_orders (id) ON DELETE RESTRICT,
  -- The India receipt date; its rules are D14 and D17 (part 2).
  received_on date NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid NOT NULL CONSTRAINT goods_receipts_recorded_by_fkey REFERENCES users (id),
  -- RECEIPT_NOTE_MAX code points, trimmed; absent is NULL. Plain text: no control
  -- character but line feed and carriage return (Unicode's Cc, spelled out as for line
  -- descriptions), the reason rule's character set.
  note text
    CONSTRAINT goods_receipts_note_valid CHECK (
      note = btrim(note)
      AND char_length(note) BETWEEN 1 AND 500
      AND note !~ '[\u0001-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]'),
  -- The target of the receipt lines' receipt key.
  CONSTRAINT goods_receipts_id_order_key UNIQUE (id, order_id)
);

-- What one receipt received on one order line, never changed (D16). Both keys carry
-- order_id, so every receipt line is on its receipt's order and on a line of that order.
CREATE TABLE goods_receipt_lines (
  receipt_id uuid NOT NULL,
  order_id uuid NOT NULL,
  line_id uuid NOT NULL,
  -- LINE_QUANTITY_MAX, as a line's quantity.
  quantity integer NOT NULL
    CONSTRAINT goods_receipt_lines_quantity_range CHECK (quantity BETWEEN 1 AND 1000000),
  -- A receipt names a line once.
  CONSTRAINT goods_receipt_lines_pkey PRIMARY KEY (receipt_id, line_id),
  CONSTRAINT goods_receipt_lines_receipt_fkey FOREIGN KEY (receipt_id, order_id)
    REFERENCES goods_receipts (id, order_id) ON DELETE RESTRICT,
  CONSTRAINT goods_receipt_lines_line_fkey FOREIGN KEY (line_id, order_id)
    REFERENCES order_lines (id, order_id) ON DELETE RESTRICT
);

-- The receipt history page and its COUNT, and the list badge's EXISTS; the recorder's
-- foreign key; INV-3 and the line key's checks (research R10). The lines' primary key
-- serves the history's lines by receipt.
CREATE INDEX goods_receipts_order_recorded_idx
  ON goods_receipts (order_id, recorded_at DESC, id DESC);
CREATE INDEX goods_receipts_recorded_by_idx ON goods_receipts (recorded_by);
CREATE INDEX goods_receipt_lines_line_idx ON goods_receipt_lines (line_id);

CREATE TRIGGER require_actor_context
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON goods_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION require_actor_context();
CREATE TRIGGER require_actor_context
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON goods_receipt_lines
  FOR EACH STATEMENT EXECUTE FUNCTION require_actor_context();

GRANT SELECT ON TABLE goods_receipts, goods_receipt_lines TO po_app;
GRANT INSERT (order_id, received_on, recorded_by, note) ON TABLE goods_receipts TO po_app;
GRANT INSERT (receipt_id, order_id, line_id, quantity) ON TABLE goods_receipt_lines TO po_app;

-- IDEMPOTENT_OPERATIONS: receipts are idempotent like creates (research R7).
ALTER TABLE idempotency_keys
  DROP CONSTRAINT idempotency_keys_operation_valid,
  ADD CONSTRAINT idempotency_keys_operation_valid
    CHECK (operation IN ('createOrder', 'recordReceipt'));

-- ---------------------------------------------------------------------------------------
-- Part 2: the receipt rules (D12-D17), the received-quantity guard, the open-line
-- recompute and D10's fully-received branch (research R2-R4). Custom SQLSTATEs, mapped in
-- backend/src/db/errors.ts; each means the service let through something it should have
-- refused:
--   PO020 ORDER_NOT_RECEIVABLE      a receipt on an order that isn't APPROVED (D12)
--   PO021 RECEIPT_NOT_BY_OWNER      recorded_by not the owner, or not the actor (D13)
--   PO022 RECEIPT_EXCEEDS_ORDERED   received above ordered (D15)
--   PO023 RECEIPT_IMMUTABLE         a receipt or receipt line updated, deleted or
--                                   truncated, or a line added to a receipt by a later
--                                   statement (D16)
--   PO024 RECEIPT_BEFORE_APPROVAL   received_on before the approval date (D14)
--   PO025 RECEIPT_DATE_TOO_LATE     received_on after the database's India date + 1 (D17)
-- and 23514 on goods_receipts_has_lines: a receipt with no line.
-- ---------------------------------------------------------------------------------------

-- Recomputes only the open-line count (INV-6) of the given orders, for receipts, which
-- never change the total: the same order lock and flag as recompute_orders. Its runs are
-- counted in po.open_line_recompute_count for the trigger-count tests. The order's
-- version is untouched: receipts never conflict with an If-Match.
CREATE FUNCTION recompute_open_lines(order_ids uuid[]) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF order_ids IS NULL OR cardinality(order_ids) = 0 THEN
    RETURN;
  END IF;
  PERFORM 1 FROM public.purchase_orders
    WHERE id = ANY(order_ids) ORDER BY id FOR NO KEY UPDATE;
  PERFORM set_config('po.recompute', txid_current()::text, true);
  UPDATE public.purchase_orders o
     SET open_line_count = s.open_lines
    FROM (SELECT ids.id,
                 count(l.id) FILTER (WHERE l.received_quantity < l.quantity) AS open_lines
            FROM unnest(order_ids) AS ids(id)
            LEFT JOIN public.order_lines l ON l.order_id = ids.id
           GROUP BY ids.id) s
   WHERE o.id = s.id AND o.open_line_count <> s.open_lines;
  PERFORM set_config('po.recompute', '', true);
  PERFORM set_config('po.open_line_recompute_count',
    (coalesce(nullif(current_setting('po.open_line_recompute_count', true), ''), '0')::int + 1)::text,
    true);
END
$$;

-- A line change that touches only received_quantity (a receipt) recomputes the open-line
-- count alone; anything the total reads recomputes both, as before (research R3).
CREATE OR REPLACE FUNCTION order_lines_after_update() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  edited uuid[];
  recompute uuid[];
  received uuid[];
BEGIN
  -- Orders with a line changed in anything but received_quantity must be drafts.
  SELECT array_agg(DISTINCT x.order_id) INTO edited
    FROM old_lines o JOIN new_lines n ON n.id = o.id,
         LATERAL (VALUES (o.order_id), (n.order_id)) AS x(order_id)
   WHERE (o.order_id, o.position, o.description, o.quantity, o.unit_price)
         IS DISTINCT FROM (n.order_id, n.position, n.description, n.quantity, n.unit_price);
  PERFORM public.order_lines_require_drafts(edited);
  SELECT array_agg(DISTINCT x.order_id) INTO recompute
    FROM old_lines o JOIN new_lines n ON n.id = o.id,
         LATERAL (VALUES (o.order_id), (n.order_id)) AS x(order_id)
   WHERE (o.order_id, o.quantity, o.unit_price) IS DISTINCT FROM (n.order_id, n.quantity, n.unit_price);
  PERFORM public.recompute_orders(recompute);
  SELECT array_agg(DISTINCT n.order_id) INTO received
    FROM old_lines o JOIN new_lines n ON n.id = o.id
   WHERE o.received_quantity IS DISTINCT FROM n.received_quantity
     AND n.order_id <> ALL(coalesce(recompute, '{}'));
  PERFORM public.recompute_open_lines(received);
  RETURN NULL;
END
$$;

-- received_quantity is written only by goods_receipt_lines_after_insert, under the
-- transaction-local
-- flag po.receipts, whatever the role: a privileged write gets a loud error.
CREATE FUNCTION order_lines_received_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.received_quantity <> 0 THEN
      RAISE EXCEPTION 'DERIVED_VALUE_READ_ONLY' USING
        ERRCODE = 'PO005', DETAIL = 'a new line starts with nothing received';
    END IF;
  ELSIF NEW.received_quantity IS DISTINCT FROM OLD.received_quantity
        AND current_setting('po.receipts', true) IS DISTINCT FROM txid_current()::text THEN
    RAISE EXCEPTION 'DERIVED_VALUE_READ_ONLY' USING
      ERRCODE = 'PO005',
      DETAIL = format('line %s: received_quantity is derived from its receipts', OLD.id);
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER order_lines_received_guard
  BEFORE INSERT OR UPDATE ON order_lines
  FOR EACH ROW EXECUTE FUNCTION order_lines_received_guard();

-- recorded_at is the database clock, whatever is sent.
CREATE FUNCTION goods_receipts_before_insert() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.recorded_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER goods_receipts_before_insert
  BEFORE INSERT ON goods_receipts
  FOR EACH ROW EXECUTE FUNCTION goods_receipts_before_insert();

-- A receipt has at least one line, inserted in the same statement (research R1): at the
-- end of a statement, its after-statement triggers see every row the statement wrote,
-- a CTE's included.
CREATE FUNCTION goods_receipts_after_insert() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  bad uuid;
BEGIN
  SELECT r.id INTO bad FROM new_receipts r
   WHERE NOT EXISTS (SELECT 1 FROM public.goods_receipt_lines l WHERE l.receipt_id = r.id)
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'a receipt has at least one line' USING
      ERRCODE = 'check_violation', CONSTRAINT = 'goods_receipts_has_lines',
      TABLE = 'goods_receipts', DETAIL = format('receipt %s has no line', bad);
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER goods_receipts_after_insert
  AFTER INSERT ON goods_receipts REFERENCING NEW TABLE AS new_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION goods_receipts_after_insert();

-- Once per receipt-line statement (research R2): lock the orders, then the lines, in id
-- order; then check, reading each line's receipt: D16 (a receipt with lines from another
-- statement), D12, D13, D14, D17, and D15 on the sums over every receipt in the
-- statement; then one set-based update of the lines' received quantities under the
-- po.receipts flag. The service has already locked the order FOR UPDATE and the lines FOR
-- UPDATE, so these locks are no-ops there; the lines take FOR NO KEY UPDATE so a raw
-- insert, whose foreign-key check holds KEY SHARE on its lines, never deadlocks with
-- another.
CREATE FUNCTION goods_receipt_lines_after_insert() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  bad record;
  actor uuid;
BEGIN
  PERFORM 1 FROM public.purchase_orders
    WHERE id IN (SELECT order_id FROM new_lines) ORDER BY id FOR NO KEY UPDATE;
  PERFORM 1 FROM public.order_lines
    WHERE id IN (SELECT line_id FROM new_lines) ORDER BY id FOR NO KEY UPDATE;
  -- D16: a receipt's lines all arrive in one INSERT statement. A receipt in this statement
  -- with a line from any other statement is refused; with goods_receipts_has_lines (every
  -- receipt has a line when its own statement ends) no later statement, in this
  -- transaction or another, can add a line to a receipt.
  SELECT l.receipt_id INTO bad FROM public.goods_receipt_lines l
   WHERE l.receipt_id IN (SELECT receipt_id FROM new_lines)
     AND NOT EXISTS (SELECT 1 FROM new_lines n
                      WHERE n.receipt_id = l.receipt_id AND n.line_id = l.line_id)
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'RECEIPT_IMMUTABLE' USING
      ERRCODE = 'PO023',
      DETAIL = format('receipt %s already has lines: its lines arrive in one statement',
                      bad.receipt_id);
  END IF;
  -- D12.
  SELECT o.id, o.status INTO bad FROM public.purchase_orders o
   WHERE o.id IN (SELECT order_id FROM new_lines) AND o.status <> 'APPROVED'
   ORDER BY o.id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_RECEIVABLE' USING
      ERRCODE = 'PO020', DETAIL = format('order %s is %s', bad.id, bad.status);
  END IF;
  -- D13: by the owner, who is the USER actor in context.
  IF current_setting('app.actor_type', true) = 'USER' THEN
    actor := nullif(current_setting('app.actor_user_id', true), '')::uuid;
  END IF;
  SELECT g.order_id INTO bad
    FROM public.goods_receipts g JOIN public.purchase_orders o ON o.id = g.order_id
   WHERE g.id IN (SELECT receipt_id FROM new_lines)
     AND (actor IS NULL OR g.recorded_by <> o.owner_id OR g.recorded_by <> actor)
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'RECEIPT_NOT_BY_OWNER' USING
      ERRCODE = 'PO021',
      DETAIL = format('order %s: receipts are recorded by its owner, as the actor', bad.order_id);
  END IF;
  -- D14 and D17 (RECEIPT_TIME_ZONE).
  SELECT g.order_id, g.received_on INTO bad
    FROM public.goods_receipts g JOIN public.purchase_orders o ON o.id = g.order_id
   WHERE g.id IN (SELECT receipt_id FROM new_lines)
     AND g.received_on < (o.approved_at AT TIME ZONE 'Asia/Kolkata')::date
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'RECEIPT_BEFORE_APPROVAL' USING
      ERRCODE = 'PO024',
      DETAIL = format('order %s: received %s, before its approval date', bad.order_id,
                      bad.received_on);
  END IF;
  SELECT g.order_id, g.received_on INTO bad FROM public.goods_receipts g
   WHERE g.id IN (SELECT receipt_id FROM new_lines)
     AND g.received_on > (now() AT TIME ZONE 'Asia/Kolkata')::date + 1
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'RECEIPT_DATE_TOO_LATE' USING
      ERRCODE = 'PO025',
      DETAIL = format('order %s: received %s, after tomorrow', bad.order_id, bad.received_on);
  END IF;
  -- D15.
  SELECT l.order_id, l.position, l.quantity, l.received_quantity, s.asked INTO bad
    FROM public.order_lines l
    JOIN (SELECT line_id, sum(quantity) AS asked FROM new_lines GROUP BY line_id) s
      ON s.line_id = l.id
   WHERE l.received_quantity + s.asked > l.quantity
   ORDER BY l.order_id, l.position LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'RECEIPT_EXCEEDS_ORDERED' USING
      ERRCODE = 'PO022',
      DETAIL = format('order %s line %s: ordered %s, received %s, asked %s', bad.order_id,
                      bad.position + 1, bad.quantity, bad.received_quantity, bad.asked);
  END IF;
  PERFORM set_config('po.receipts', txid_current()::text, true);
  UPDATE public.order_lines l
     SET received_quantity = l.received_quantity + s.asked
    FROM (SELECT line_id, sum(quantity) AS asked FROM new_lines GROUP BY line_id) s
   WHERE l.id = s.line_id;
  PERFORM set_config('po.receipts', '', true);
  RETURN NULL;
END
$$;

CREATE TRIGGER goods_receipt_lines_after_insert
  AFTER INSERT ON goods_receipt_lines REFERENCING NEW TABLE AS new_lines
  FOR EACH STATEMENT EXECUTE FUNCTION goods_receipt_lines_after_insert();

-- D16: receipts and their lines never change, for any role (po_app has no privilege to
-- try).
CREATE FUNCTION receipts_immutable() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'RECEIPT_IMMUTABLE' USING
    ERRCODE = 'PO023', DETAIL = format('%s is never changed (%s)', TG_TABLE_NAME, TG_OP);
END
$$;

CREATE TRIGGER receipts_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON goods_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION receipts_immutable();
CREATE TRIGGER receipts_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON goods_receipt_lines
  FOR EACH STATEMENT EXECUTE FUNCTION receipts_immutable();

-- D10 extended (ADR-0001 T10): a fully received order (no open line) is never cancelled.
-- The rest of the guard is migration 0015's, unchanged.
CREATE OR REPLACE FUNCTION purchase_orders_cancel_guard() RETURNS trigger
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
  IF OLD.open_line_count = 0 THEN
    RAISE EXCEPTION 'ORDER_CANCEL_REFUSED' USING
      ERRCODE = 'PO019', DETAIL = format('order %s is fully received', OLD.id);
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

-- Nobody calls these directly; triggers fire without EXECUTE.
REVOKE ALL ON FUNCTION recompute_open_lines(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION order_lines_received_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION goods_receipts_before_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION goods_receipts_after_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION goods_receipt_lines_after_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION receipts_immutable() FROM PUBLIC;
