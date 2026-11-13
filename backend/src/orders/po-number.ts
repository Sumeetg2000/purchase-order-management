import type { AuditedTransaction } from '../db/transaction.js';

// PO numbers (ADR-0001, amended 2026-11-12; research R2): PO-{FY}-{seq}, the financial year
// in Asia/Kolkata (po_financial_year) and a per-year counter row. The create takes its
// number as its last write before the audit entry, so the counter row stays locked only
// from here to commit, and a create that rolls back takes no number: the only gaps are
// deleted drafts. Slice 4's tests and the load seed reuse this statement.

/**
 * Gives the order, inserted earlier in `tx` with no number, the next number of the
 * financial year of `asOf` (the database clock unless a test injects a time).
 */
export async function assignPoNumber(
  tx: AuditedTransaction,
  orderId: string,
  asOf?: Date,
): Promise<string> {
  const [row] = await tx.$queryRaw<{ poNumber: string }[]>`
    WITH n AS (
      INSERT INTO po_number_counters (fy, last_value)
      VALUES (po_financial_year(COALESCE(${asOf?.toISOString() ?? null}::timestamptz, now())), 1)
      ON CONFLICT (fy) DO UPDATE SET last_value = po_number_counters.last_value + 1
      RETURNING fy, last_value
    )
    UPDATE purchase_orders o
       -- At least 6 digits; lpad alone would cut a 7th (1000000 → 100000, a duplicate).
       SET po_number = format('PO-%s-%s', n.fy,
                              lpad(n.last_value::text, greatest(6, length(n.last_value::text)), '0'))
      FROM n
     WHERE o.id = ${orderId}::uuid AND o.po_number IS NULL
    RETURNING o.po_number AS "poNumber"`;
  if (!row) throw new Error(`order ${orderId} has no row without a PO number to number`);
  return row.poNumber;
}
