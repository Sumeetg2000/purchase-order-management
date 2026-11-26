import type { OrderStatus } from '@po/contracts';
import { describe, expect, it } from 'vitest';
import { orderFixture } from '../support/orders-sql.js';

// Migration 0017's indexes for the outstanding report (ADR-0015, amended 2026-11-26):
// three partial indexes on approved orders with an open line, each in the report's order.

// Typed against the status list, so a renamed status fails the typecheck here too.
const APPROVED: OrderStatus = 'APPROVED';
const OUTSTANDING = `WHERE ((status = '${APPROVED}'::text) AND (open_line_count > 0))`;

describe('[FR-RPT-02] the outstanding report indexes', () => {
  it('[FR-RPT-02] three partial indexes on approved, still-open orders, and no other', async () => {
    const { superuser: q } = await orderFixture();
    const { rows } = await q.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'purchase_orders' AND indexdef ILIKE '%open_line_count%'
        ORDER BY indexname`,
    );
    expect(rows.map((r) => [r.indexname, r.indexdef.replace(/^.* USING btree /, '')])).toEqual([
      ['purchase_orders_outstanding_idx', `(approved_at, id) ${OUTSTANDING}`],
      [
        'purchase_orders_outstanding_owner_idx',
        `(owner_id, approved_at, id) INCLUDE (vendor_id) ${OUTSTANDING}`,
      ],
      ['purchase_orders_outstanding_vendor_idx', `(vendor_id, approved_at, id) ${OUTSTANDING}`],
    ]);
  });
});
