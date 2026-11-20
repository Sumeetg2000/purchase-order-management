import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  INSUFFICIENT_PRIVILEGE,
  CHECK_VIOLATION,
  createDraft,
  orderFixture,
  plantCancelled,
  plantSubmitted,
  reconciliationRows,
  sqlstate,
  type OrderFixture,
} from '../support/orders-sql.js';

// The approval half of the integrity attack suite (§6, slice 4 research R2): every raw-SQL
// path to an order approved, rejected or routed against the rules, as the application
// role and as the privileged owner role. Each is refused with its SQLSTATE, and the
// reconciliation (with its approval branch) returns no rows afterwards.

const SNAPSHOT = `'{"id":"x","name":"x","contactName":null,"contactEmail":null,
                   "contactPhone":null,"paymentTerms":{}}'`;

async function as(
  q: pg.Client,
  actorType: string,
  userId: string,
  sql: string[],
  params: unknown[],
) {
  await q.query('BEGIN');
  try {
    await q.query(
      `SELECT set_config('app.actor_txid', txid_current()::text, true),
              set_config('app.actor_type', $1, true),
              set_config('app.actor_user_id', $2, true),
              set_config('app.actor_name', CASE WHEN $1 = 'USER' THEN 'A' ELSE '' END, true),
              set_config('app.actor_email', CASE WHEN $1 = 'USER' THEN 'a@x.test' ELSE '' END, true),
              set_config('app.acting_role', CASE WHEN $1 = 'USER' THEN 'BUYER' ELSE '' END, true)`,
      [actorType, userId],
    );
    for (const statement of sql) await q.query(statement, params);
    await q.query('COMMIT');
  } catch (error) {
    await q.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function bigDraft(f: OrderFixture) {
  return createDraft(f, [{ quantity: 3, unitPrice: '100000' }]);
}

/** Every attack for one client role; returns the SQLSTATE of each. */
async function attacks(
  f: OrderFixture,
  client: pg.Client,
): Promise<Record<string, string | undefined>> {
  const results: Record<string, string | undefined> = {};
  const run = async (name: string, actor: string, user: string, sql: string[], orderId: string) => {
    results[name] = await sqlstate(() => as(client, actor, user, sql, [orderId]));
  };
  // A hand-made auto-approval above the threshold.
  const auto = await bigDraft(f);
  await run(
    'auto-approve above the threshold',
    'SYSTEM',
    '',
    [
      `INSERT INTO approval_rounds (order_id, round, policy_version, total, vendor_snapshot, submitted_by)
     SELECT id, 1, 1, total, ${SNAPSHOT}, owner_id FROM purchase_orders WHERE id = $1`,
      `UPDATE approval_rounds SET outcome = 'AUTO_APPROVED', closed_at = now() WHERE order_id = $1`,
      `UPDATE purchase_orders SET status = 'APPROVED', current_round = 1, submitted_at = now(),
            approved_at = now() WHERE id = $1`,
    ],
    auto.orderId,
  );
  // A pending order approved with no decision.
  const pending = await bigDraft(f);
  await plantSubmitted(f, pending.orderId, 'PENDING_APPROVAL');
  await run(
    'approve with the step open',
    'USER',
    f.buyerId,
    [`UPDATE purchase_orders SET status = 'APPROVED', approved_at = now() WHERE id = $1`],
    pending.orderId,
  );
  // The owner deciding their own step.
  await run(
    'owner decides own step',
    'USER',
    f.buyerId,
    [
      `UPDATE approval_steps s SET state = 'APPROVED', decided_by = o.owner_id, decided_at = now(),
            decided_version = o.version
       FROM purchase_orders o WHERE o.id = $1 AND s.order_id = o.id`,
    ],
    pending.orderId,
  );
  // Rewriting the round's total, or the order's submission.
  await run(
    'rewrite the round total',
    'USER',
    f.buyerId,
    [`UPDATE approval_rounds SET total = 1 WHERE order_id = $1`],
    pending.orderId,
  );
  await run(
    'move the submission time',
    'USER',
    f.buyerId,
    [`UPDATE purchase_orders SET submitted_at = now() - interval '1 day' WHERE id = $1`],
    pending.orderId,
  );
  await run(
    'delete the steps',
    'USER',
    f.buyerId,
    [`DELETE FROM approval_steps WHERE order_id = $1`],
    pending.orderId,
  );
  // A rejected order reopened.
  const rejected = await bigDraft(f);
  await plantSubmitted(f, rejected.orderId, 'REJECTED');
  await run(
    'reopen a rejected order',
    'USER',
    f.buyerId,
    [`UPDATE purchase_orders SET status = 'PENDING_APPROVAL' WHERE id = $1`],
    rejected.orderId,
  );
  await run(
    'void the rejection',
    'USER',
    f.buyerId,
    [
      `UPDATE approval_steps SET state = 'VOIDED', voided_at = now(), reason = NULL WHERE order_id = $1`,
    ],
    rejected.orderId,
  );
  // An approved order cancelled by its owner, without its record, or changing its approval
  // with the cancel (slice 5, D10 and D11).
  const approved = await bigDraft(f);
  const { approverId } = await plantSubmitted(f, approved.orderId, 'APPROVED');
  await run(
    'cancel as the owner',
    'USER',
    f.buyerId,
    [
      `UPDATE purchase_orders SET status = 'CANCELLED', cancelled_by = owner_id,
            cancel_reason = 'Mine', version = version + 1 WHERE id = $1`,
    ],
    approved.orderId,
  );
  await run(
    'cancel without a record',
    'USER',
    approverId,
    [`UPDATE purchase_orders SET status = 'CANCELLED', version = version + 1 WHERE id = $1`],
    approved.orderId,
  );
  await run(
    'move the approval with the cancel',
    'USER',
    approverId,
    [
      `UPDATE purchase_orders SET status = 'CANCELLED', cancelled_by = '${approverId}',
            cancel_reason = 'Late', version = version + 1, approved_at = now() - interval '1 day'
        WHERE id = $1`,
    ],
    approved.orderId,
  );
  // A cancelled order reopened, or its record rewritten (D9).
  const cancelled = await bigDraft(f);
  await plantCancelled(f, cancelled.orderId);
  await run(
    'reopen a cancelled order',
    'USER',
    f.buyerId,
    [`UPDATE purchase_orders SET status = 'APPROVED' WHERE id = $1`],
    cancelled.orderId,
  );
  await run(
    'rewrite the cancel reason',
    'USER',
    f.buyerId,
    [`UPDATE purchase_orders SET cancel_reason = 'Something else' WHERE id = $1`],
    cancelled.orderId,
  );
  await run(
    'move the cancel time',
    'USER',
    f.buyerId,
    [`UPDATE purchase_orders SET cancelled_at = now() - interval '1 day' WHERE id = $1`],
    cancelled.orderId,
  );
  return results;
}

describe('[FR-LCK-01] approval attacks as the application role and the owner role', () => {
  it('[FR-LCK-01] every attack as po_app is refused, and the reconciliation stays empty', async () => {
    const f = await orderFixture();
    expect(await attacks(f, f.app)).toEqual({
      'auto-approve above the threshold': 'PO014',
      'approve with the step open': 'PO014',
      'owner decides own step': 'PO016',
      'rewrite the round total': INSUFFICIENT_PRIVILEGE,
      'move the submission time': 'PO015',
      'delete the steps': INSUFFICIENT_PRIVILEGE,
      // D9 fires before the transition check (PO009) since slice 5: still refused.
      'reopen a rejected order': 'PO018',
      'void the rejection': 'PO012',
      'cancel as the owner': 'PO016',
      'cancel without a record': CHECK_VIOLATION,
      'move the approval with the cancel': 'PO019',
      'reopen a cancelled order': 'PO018',
      'rewrite the cancel reason': 'PO018',
      'move the cancel time': INSUFFICIENT_PRIVILEGE,
    });
    expect(await reconciliationRows(f.app)).toEqual([]);
  });

  it('[FR-LCK-01] the owner role, past every grant, is refused by the same rules', async () => {
    const f = await orderFixture();
    expect(await attacks(f, f.owner)).toEqual({
      'auto-approve above the threshold': 'PO014',
      'approve with the step open': 'PO014',
      'owner decides own step': 'PO016',
      'rewrite the round total': 'PO013',
      'move the submission time': 'PO015',
      'delete the steps': 'PO012',
      // D9 fires before the transition check (PO009) since slice 5: still refused.
      'reopen a rejected order': 'PO018',
      'void the rejection': 'PO012',
      'cancel as the owner': 'PO016',
      'cancel without a record': CHECK_VIOLATION,
      'move the approval with the cancel': 'PO019',
      'reopen a cancelled order': 'PO018',
      'rewrite the cancel reason': 'PO018',
      'move the cancel time': 'PO018',
    });
    expect(await reconciliationRows(f.app)).toEqual([]);
  });
});
