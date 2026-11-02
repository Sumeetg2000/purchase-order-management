-- Reconciliation: every row this query returns is a stored derived value that disagrees
-- with what it is derived from (ADR-0003, Principle I). It must always return no rows; the
-- migrations test runs it as po_app, and later slices run it after every integrity test.
--
-- Columns: invariant (the invariant's id), entity_id (the row that breaks it), detail.
--
-- Slice 0 stores no derived values, so there are no invariants yet. Slice 3 adds INV-1 to
-- INV-6 (order totals, line totals, outstanding quantities, open line counts) as UNION ALL
-- branches of this query.
SELECT NULL::text AS invariant, NULL::text AS entity_id, NULL::text AS detail
WHERE false;
