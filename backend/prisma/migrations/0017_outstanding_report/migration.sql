-- The outstanding orders report (specs/008-outstanding-report/data-model.md, research R4,
-- ADR-0015 amended 2026-11-26). Outstanding = approved with at least one line not fully
-- received (open_line_count, INV-6). Three partial indexes, each in the report's order
-- (oldest approval first, then id); they hold only open approved orders, so they shrink
-- as orders complete. tests/integration/report-schema.test.ts pins them. Runs as po_owner.

-- The Approver's and Admin's report, unfiltered or by age bucket (an approved_at range).
CREATE INDEX purchase_orders_outstanding_idx
  ON purchase_orders (approved_at, id)
  WHERE status = 'APPROVED' AND open_line_count > 0;

-- The report by vendor, and the vendor summary for the Approver and Admin (index-only).
CREATE INDEX purchase_orders_outstanding_vendor_idx
  ON purchase_orders (vendor_id, approved_at, id)
  WHERE status = 'APPROVED' AND open_line_count > 0;

-- A Buyer's own report and summary; vendor_id included so the summary groups without
-- visiting the table.
CREATE INDEX purchase_orders_outstanding_owner_idx
  ON purchase_orders (owner_id, approved_at, id) INCLUDE (vendor_id)
  WHERE status = 'APPROVED' AND open_line_count > 0;
