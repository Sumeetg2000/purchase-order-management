import { describe, expect, it } from 'vitest';
import {
  DERIVED_VALUE_READ_ONLY,
  INSUFFICIENT_PRIVILEGE,
  createDraft,
  orderFixture,
  plantSubmitted,
  readOrder,
  reconciliationRows,
  sqlstate,
  type OrderFixture,
} from '../support/orders-sql.js';
import {
  ORDER_CANCEL_REFUSED,
  ORDER_NOT_RECEIVABLE,
  RECEIPT_BEFORE_APPROVAL,
  RECEIPT_DATE_TOO_LATE,
  RECEIPT_EXCEEDS_ORDERED,
  RECEIPT_NOT_BY_OWNER,
  anotherBuyer,
  approvalDate,
  approvedDaysAgo,
  approvedOrder,
  asActor,
  buyer,
  databaseDate,
  insertReceipts,
  readLines,
  receive,
  type ReceiptRow,
  type SqlActor,
} from '../support/receipts-sql.js';
import { plantsViolations } from '../support/setup.js';

// The receipt attack suite (specs/007-goods-receipt/research.md R2, R4; ADR-0003): raw SQL
// as po_app and as po_owner, the privileged role, tries every way to over-receive, receive
// where it mustn't, or write a received quantity or open-line count directly. Each is
// refused loudly (never silently fixed), and every test ends with the reconciliation
// returning no rows, INV-3 included.

const ROLES = ['po_app', 'po_owner'] as const;
type Role = (typeof ROLES)[number];

function client(f: OrderFixture, role: Role) {
  return role === 'po_app' ? f.app : f.owner;
}

/** The SQLSTATE of `sql` run as `role` in one transaction as `actor`. */
function asRole(
  f: OrderFixture,
  role: Role,
  sql: string,
  params: unknown[] = [],
  actor: SqlActor = buyer(f),
) {
  return sqlstate(() => asActor(client(f, role), actor, (q) => q.query(sql, params)));
}

function receiptAs(
  f: OrderFixture,
  role: Role,
  orderId: string,
  rows: readonly ReceiptRow[],
  actor: SqlActor = buyer(f),
) {
  return sqlstate(() => asActor(client(f, role), actor, (q) => insertReceipts(q, orderId, rows)));
}

async function expectReconciled(f: OrderFixture): Promise<void> {
  expect(await reconciliationRows(f.app)).toEqual([]);
}

describe('[FR-PO-03] received quantities are written only by receipts', () => {
  for (const role of ROLES) {
    const refusal = role === 'po_app' ? INSUFFICIENT_PRIVILEGE : DERIVED_VALUE_READ_ONLY;

    it(`[FR-PO-03] ${role}: a direct write of received_quantity is refused (${refusal})`, async () => {
      const f = await orderFixture();
      const approved = await approvedOrder(f, [{ quantity: 5, unitPrice: '1' }]);
      const draft = await createDraft(f, [{ quantity: 5, unitPrice: '1' }]);
      for (const orderId of [approved.orderId, draft.orderId]) {
        for (const set of ['received_quantity = 1', 'received_quantity = quantity']) {
          expect(
            await asRole(f, role, `UPDATE order_lines SET ${set} WHERE order_id = $1`, [orderId]),
            `${orderId}: ${set}`,
          ).toBe(refusal);
        }
      }
      expect((await readLines(f.app, approved.orderId))[0]?.received_quantity).toBe(0);
      await expectReconciled(f);
    });

    it(`[FR-PO-03] ${role}: a line inserted with a received quantity is refused (${refusal})`, async () => {
      const f = await orderFixture();
      const { orderId } = await createDraft(f, [{ quantity: 5, unitPrice: '1' }]);
      expect(
        await asRole(
          f,
          role,
          `INSERT INTO order_lines (id, order_id, position, description, quantity, unit_price,
                                    received_quantity)
           VALUES (gen_random_uuid(), $1, 1, 'Extra', 5, 1, 2)`,
          [orderId],
        ),
      ).toBe(refusal);
      await expectReconciled(f);
    });

    it(`[FR-PO-03] ${role}: a direct write of open_line_count on an approved order is refused`, async () => {
      const f = await orderFixture();
      const { orderId } = await approvedOrder(f, [{ quantity: 5, unitPrice: '1' }]);
      expect(
        await asRole(f, role, `UPDATE purchase_orders SET open_line_count = 0 WHERE id = $1`, [
          orderId,
        ]),
      ).toBe(role === 'po_app' ? INSUFFICIENT_PRIVILEGE : DERIVED_VALUE_READ_ONLY);
      expect(await readOrder(f.app, orderId)).toMatchObject({ open_line_count: 1 });
      await expectReconciled(f);
    });
  }
});

describe('[FR-RCV-02] receipt attacks, as po_app and as po_owner', () => {
  for (const role of ROLES) {
    it(`[FR-RCV-02] ${role}: over-receipt on any insert path is refused (PO022)`, async () => {
      const f = await orderFixture();
      const { orderId, lineIds } = await approvedOrder(f, [
        { quantity: 5, unitPrice: '1' },
        { quantity: 2, unitPrice: '1' },
      ]);
      const [a = '', b = ''] = lineIds;
      expect(await receiptAs(f, role, orderId, [{ lineId: a, quantity: 6 }])).toBe(
        RECEIPT_EXCEEDS_ORDERED,
      );
      expect(
        await receiptAs(f, role, orderId, [
          { lineId: a, quantity: 5 },
          { lineId: b, quantity: 1 },
          { lineId: b, quantity: 2 },
        ]),
      ).toBe(RECEIPT_EXCEEDS_ORDERED);
      await receive(f, orderId, [{ lineId: b, quantity: 2 }]);
      expect(await receiptAs(f, role, orderId, [{ lineId: b, quantity: 1 }])).toBe(
        RECEIPT_EXCEEDS_ORDERED,
      );
      expect((await readLines(f.app, orderId)).map((l) => l.received_quantity)).toEqual([0, 2]);
      await expectReconciled(f);
    });

    it(`[FR-RCV-02] ${role}: receipts on a non-approved order, by someone else, or misdated are refused`, async () => {
      const f = await orderFixture();
      const other = await anotherBuyer(f);
      const pending = await createDraft(f, [{ quantity: 2, unitPrice: '60000' }]);
      await plantSubmitted(f, pending.orderId, 'PENDING_APPROVAL');
      expect(
        await receiptAs(f, role, pending.orderId, [
          { lineId: pending.lineIds[0] ?? '', quantity: 1 },
        ]),
      ).toBe(ORDER_NOT_RECEIVABLE);
      const { orderId, lineIds } = await approvedOrder(f, [{ quantity: 5, unitPrice: '1' }]);
      await approvedDaysAgo(f, orderId, 2);
      const lineId = lineIds[0] ?? '';
      expect(
        await receiptAs(f, role, orderId, [{ lineId, quantity: 1, recordedBy: other }], {
          type: 'USER',
          userId: other,
          role: 'BUYER',
        }),
      ).toBe(RECEIPT_NOT_BY_OWNER);
      expect(
        await receiptAs(f, role, orderId, [
          { lineId, quantity: 1, receivedAt: await approvalDate(f.app, orderId, -1) },
        ]),
      ).toBe(RECEIPT_BEFORE_APPROVAL);
      expect(
        await receiptAs(f, role, orderId, [
          { lineId, quantity: 1, receivedAt: await databaseDate(f.app, 30) },
        ]),
      ).toBe(RECEIPT_DATE_TOO_LATE);
      expect((await readLines(f.app, orderId))[0]?.received_quantity).toBe(0);
      await expectReconciled(f);
    });
  }

  it('[FR-PO-03] cancelling a fully received order by SQL is refused (PO019); a partly received one cancels', async () => {
    const f = await orderFixture();
    const full = await approvedOrder(f, [{ quantity: 2, unitPrice: '1' }]);
    const part = await approvedOrder(f, [
      { quantity: 2, unitPrice: '1' },
      { quantity: 2, unitPrice: '1' },
    ]);
    await receive(f, full.orderId, [{ lineId: full.lineIds[0] ?? '', quantity: 2 }]);
    await receive(f, part.orderId, [{ lineId: part.lineIds[0] ?? '', quantity: 2 }]);
    const cancel = (orderId: string, approverId: string) =>
      sqlstate(() =>
        asActor(f.app, { type: 'USER', userId: approverId, role: 'APPROVER' }, (q) =>
          q.query(
            `UPDATE purchase_orders
                SET status = 'CANCELLED', cancelled_by = $2, cancel_reason = 'Not needed',
                    version = version + 1
              WHERE id = $1`,
            [orderId, approverId],
          ),
        ),
      );
    expect(await cancel(full.orderId, full.approverId)).toBe(ORDER_CANCEL_REFUSED);
    expect(await readOrder(f.app, full.orderId)).toMatchObject({ status: 'APPROVED' });
    expect(await cancel(part.orderId, part.approverId)).toBeUndefined();
    expect(await readOrder(f.app, part.orderId)).toMatchObject({ status: 'CANCELLED' });
    await expectReconciled(f);
  });
});

describe('[FR-RCV-02] INV-3 catches a planted drift', () => {
  it('[FR-RCV-02] po_owner forging the receipts flag writes a received quantity, and the reconciliation reports it', async () => {
    const f = await orderFixture();
    plantsViolations(f.db);
    const { orderId, lineIds } = await approvedOrder(f, [{ quantity: 5, unitPrice: '1' }]);
    await receive(f, orderId, [{ lineId: lineIds[0] ?? '', quantity: 2 }]);
    await asActor(f.owner, buyer(f), async (q) => {
      await q.query(`SELECT set_config('po.receipts', txid_current()::text, true)`);
      await q.query(`UPDATE order_lines SET received_quantity = 4 WHERE id = $1`, [lineIds[0]]);
    });
    expect(
      (await reconciliationRows(f.app)).map((r) => [r.invariant, r.entity_id, r.detail]),
    ).toEqual([['INV-3', lineIds[0], 'received_quantity 4, receipts sum to 2']]);
  });
});
