-- Reconciliation: every row this query returns is a stored derived value that disagrees
-- with what it is derived from (ADR-0003, Principle I). It must always return no rows.
-- Tests run it as po_app after every test database and attack, and seeds after seeding.
--
-- Columns: invariant (the invariant's id), entity_id (the row that breaks it), detail.
-- INV-3 (received quantity = Σ receipts) joins with the receipts table in slice 6.
WITH line_sums AS (
  SELECT order_id,
         sum(line_total) AS total,
         count(*) FILTER (WHERE received_quantity < quantity) AS open_lines
    FROM order_lines
   GROUP BY order_id
),
violations AS (
  -- INV-1: line_total = quantity × unit_price, exactly.
  SELECT 'INV-1' AS invariant, l.id::text AS entity_id,
         format('line_total %s, quantity × unit_price %s',
                l.line_total, (l.quantity * l.unit_price)::numeric(22, 4)) AS detail
    FROM order_lines l
   WHERE l.line_total IS DISTINCT FROM l.quantity * l.unit_price
  UNION ALL
  -- INV-2: order.total = Σ line_total.
  SELECT 'INV-2', o.id::text,
         format('total %s, lines sum to %s', o.total, coalesce(s.total, 0)::numeric(22, 4))
    FROM purchase_orders o LEFT JOIN line_sums s ON s.order_id = o.id
   WHERE o.total <> coalesce(s.total, 0)
  UNION ALL
  -- INV-4: 0 ≤ received_quantity ≤ quantity.
  SELECT 'INV-4', l.id::text,
         format('received_quantity %s, quantity %s', l.received_quantity, l.quantity)
    FROM order_lines l
   WHERE l.received_quantity < 0 OR l.received_quantity > l.quantity
  UNION ALL
  -- INV-5: every order has at least one line.
  SELECT 'INV-5', o.id::text, 'no lines'
    FROM purchase_orders o
   WHERE NOT EXISTS (SELECT 1 FROM order_lines l WHERE l.order_id = o.id)
  UNION ALL
  -- INV-6: open_line_count = count(lines where received_quantity < quantity).
  SELECT 'INV-6', o.id::text,
         format('open_line_count %s, open lines %s', o.open_line_count, coalesce(s.open_lines, 0))
    FROM purchase_orders o LEFT JOIN line_sums s ON s.order_id = o.id
   WHERE o.open_line_count <> coalesce(s.open_lines, 0)
  UNION ALL
  -- Every committed order has its PO number (research R2).
  SELECT 'PO_NUMBER', o.id::text, 'po_number is NULL'
    FROM purchase_orders o
   WHERE o.po_number IS NULL
)
SELECT invariant, entity_id, detail FROM violations ORDER BY invariant, entity_id;
