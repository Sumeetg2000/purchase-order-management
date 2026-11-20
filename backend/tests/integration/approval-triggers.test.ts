import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  CHECK_VIOLATION,
  ORDER_LINES_LOCKED,
  ORDER_STATUS_TRANSITION_REFUSED,
  createDraft,
  inTransaction,
  orderFixture,
  plant,
  plantCancelled,
  plantSubmitted,
  readOrder,
  sqlstate,
  type OrderFixture,
} from '../support/orders-sql.js';
import { plantsViolations } from '../support/setup.js';

// Migration 0014, part 2 (specs/005-submit-approve/research.md R2, D1–D8): what the
// database itself refuses about submissions, rounds, steps and the policy, whatever the
// role. Each refusal is a custom SQLSTATE; reaching one through the API is a bug.

const STEP_REFUSED = 'PO012';
const ROUND_REFUSED = 'PO013';
const INCONSISTENT = 'PO014';
const SUBMISSION_LOCKED = 'PO015';
const SELF_DECISION = 'PO016';
const POLICY_IMMUTABLE = 'PO017';
const ORDER_CLOSED = 'PO018';
const CANCEL_REFUSED = 'PO019';
const ORDER_DELETE_REFUSED = 'PO010';

type Actor =
  | { type: 'SYSTEM' }
  | { type: 'OPERATOR' }
  | { type: 'USER'; userId: string; role: 'BUYER' | 'APPROVER' };

/** Sets the transaction's actor context as withTransaction would. */
async function actAs(q: pg.Client, actor: Actor): Promise<void> {
  await q.query(
    `SELECT set_config('app.actor_txid', txid_current()::text, true),
            set_config('app.actor_type', $1, true),
            set_config('app.actor_user_id', $2, true),
            set_config('app.actor_name', $3, true),
            set_config('app.actor_email', $4, true),
            set_config('app.acting_role', $5, true),
            set_config('app.os_user', $6, true),
            set_config('app.os_host', $6, true)`,
    [
      actor.type,
      actor.type === 'USER' ? actor.userId : '',
      actor.type === 'USER' ? 'Someone' : '',
      actor.type === 'USER' ? 'someone@example.test' : '',
      actor.type === 'USER' ? actor.role : '',
      actor.type === 'OPERATOR' ? 'tester' : '',
    ],
  );
}

/** Runs `work` in one committed transaction as `actor`; deferred checks fire at COMMIT. */
async function as<T>(q: pg.Client, actor: Actor, work: (q: pg.Client) => Promise<T>): Promise<T> {
  await q.query('BEGIN');
  try {
    await actAs(q, actor);
    const result = await work(q);
    await q.query('COMMIT');
    return result;
  } catch (error) {
    await q.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

interface Fixture extends OrderFixture {
  approverId: string;
  owner_: Actor;
  approver: Actor;
}

/** The order fixture plus an Approver, and actors for the Buyer and the Approver. */
async function fixture(): Promise<Fixture> {
  const f = await orderFixture();
  const approverId = randomUUID();
  await inTransaction(f.app, (q) =>
    q.query(
      `INSERT INTO users (id, name, email, roles, status)
       VALUES ($1, 'Priya Approver', $2, '{APPROVER}', 'ACTIVE')`,
      [approverId, `approver-${approverId}@example.test`],
    ),
  );
  return {
    ...f,
    approverId,
    owner_: { type: 'USER', userId: f.buyerId, role: 'BUYER' },
    approver: { type: 'USER', userId: approverId, role: 'APPROVER' },
  };
}

/** Adds policy version 2 with tiers ₹1,00,000 and ₹10,00,000 (a two-step chain fixture). */
async function twoTierPolicy(f: OrderFixture): Promise<void> {
  await plant(f, `INSERT INTO approval_policies (version) VALUES (2)`);
  await plant(
    f,
    `INSERT INTO approval_policy_tiers (policy_version, tier, threshold)
     VALUES (2, 1, 100000), (2, 2, 1000000)`,
  );
}

/** A draft whose total is `quantity` × ₹1,00,000. */
async function draftOf(f: OrderFixture, quantity: number) {
  return createDraft(f, [{ quantity, unitPrice: '100000' }]);
}

/**
 * The submit's statements as po_app, inside the caller's transaction: the next round
 * under the highest policy, one open step per tier the total exceeds, the order moved
 * to PENDING_APPROVAL. Returns the number of steps.
 */
async function insertSubmission(q: pg.Client, orderId: string): Promise<number> {
  await q.query(
    `INSERT INTO approval_rounds (order_id, round, policy_version, total, vendor_snapshot,
                                  submitted_by)
     SELECT o.id, coalesce(o.current_round, 0) + 1,
            (SELECT max(version) FROM approval_policies), o.total,
            jsonb_build_object('id', v.id, 'name', v.name, 'contactName', v.contact_name,
                               'contactEmail', v.contact_email, 'contactPhone', v.contact_phone,
                               'paymentTerms', jsonb_build_object('type', 'NET', 'netDays', 30)),
            o.owner_id
       FROM purchase_orders o JOIN vendors v ON v.id = o.vendor_id WHERE o.id = $1`,
    [orderId],
  );
  const { rowCount } = await q.query(
    `INSERT INTO approval_steps (order_id, round, step, tier, threshold)
     SELECT r.order_id, r.round, row_number() OVER (ORDER BY t.tier), t.tier, t.threshold
       FROM purchase_orders o
       JOIN approval_rounds r ON r.order_id = o.id AND r.round = coalesce(o.current_round, 0) + 1
       JOIN approval_policy_tiers t ON t.policy_version = r.policy_version AND t.threshold < r.total
      WHERE o.id = $1`,
    [orderId],
  );
  return rowCount ?? 0;
}

async function moveToPending(q: pg.Client, orderId: string): Promise<void> {
  await q.query(
    `UPDATE purchase_orders o
        SET status = 'PENDING_APPROVAL', current_round = r.round, submitted_at = r.submitted_at,
            version = o.version + 1
       FROM approval_rounds r
      WHERE o.id = $1 AND r.order_id = o.id AND r.round = coalesce(o.current_round, 0) + 1`,
    [orderId],
  );
}

/** A committed pending submission, as the owner. */
async function submitPending(f: Fixture, orderId: string): Promise<void> {
  await as(f.app, f.owner_, async (q) => {
    await insertSubmission(q, orderId);
    await moveToPending(q, orderId);
  });
}

/** Decides step `step` of the current round as `actor`, against the order's version. */
async function decide(
  q: pg.Client,
  orderId: string,
  step: number,
  state: 'APPROVED' | 'REJECTED',
  deciderId: string,
): Promise<void> {
  await q.query(
    `UPDATE approval_steps s
        SET state = $3, decided_by = $4, decided_at = now(), decided_version = o.version,
            reason = CASE WHEN $3 = 'REJECTED' THEN 'Too dear' END
       FROM purchase_orders o
      WHERE s.order_id = $1 AND o.id = $1 AND s.round = o.current_round AND s.step = $2`,
    [orderId, step, state, deciderId],
  );
}

/** Closes the current round and moves the order, as approve / reject do after a decision. */
async function close(q: pg.Client, orderId: string, outcome: 'APPROVED' | 'REJECTED') {
  await q.query(
    `UPDATE approval_rounds r SET outcome = $2, closed_at = now()
       FROM purchase_orders o WHERE o.id = $1 AND r.order_id = o.id AND r.round = o.current_round`,
    [orderId, outcome],
  );
  await q.query(
    `UPDATE purchase_orders SET status = $2, version = version + 1,
            approved_at = CASE WHEN $2 = 'APPROVED' THEN now() END
      WHERE id = $1`,
    [orderId, outcome],
  );
}

async function stepStates(q: pg.Client, orderId: string): Promise<string[]> {
  const { rows } = await q.query<{ s: string }>(
    `SELECT round || '.' || step || ' ' || state AS s FROM approval_steps
      WHERE order_id = $1 ORDER BY round, step`,
    [orderId],
  );
  return rows.map((r) => r.s);
}

describe('[FR-SM-01] the allowed moves succeed', () => {
  it('[FR-SM-01] submit above the threshold opens one step; the Approver approves it; the order is APPROVED', async () => {
    const f = await fixture();
    const { orderId } = await draftOf(f, 2);
    await submitPending(f, orderId);
    expect(await readOrder(f.app, orderId)).toMatchObject({
      status: 'PENDING_APPROVAL',
      version: 2,
    });
    expect(await stepStates(f.app, orderId)).toEqual(['1.1 OPEN']);
    await as(f.app, f.approver, async (q) => {
      await decide(q, orderId, 1, 'APPROVED', f.approverId);
      await close(q, orderId, 'APPROVED');
    });
    expect(await readOrder(f.app, orderId)).toMatchObject({ status: 'APPROVED', version: 3 });
  });

  it('[FR-SM-01] submit at or below the threshold is auto-approved by SYSTEM, with no step', async () => {
    const f = await fixture();
    const { orderId } = await draftOf(f, 1);
    await as(f.app, f.owner_, async (q) => {
      expect(await insertSubmission(q, orderId)).toBe(0);
      await actAs(q, { type: 'SYSTEM' });
      await q.query(
        `UPDATE approval_rounds SET outcome = 'AUTO_APPROVED', closed_at = now()
          WHERE order_id = $1 AND round = 1`,
        [orderId],
      );
      await q.query(
        `UPDATE purchase_orders SET status = 'APPROVED', current_round = 1, submitted_at = now(),
                approved_at = now(), version = version + 1 WHERE id = $1`,
        [orderId],
      );
    });
    expect(await readOrder(f.app, orderId)).toMatchObject({ status: 'APPROVED' });
  });

  it('[FR-SM-03] reject closes the round, voids the later steps and makes the order REJECTED', async () => {
    const f = await fixture();
    await twoTierPolicy(f);
    const { orderId } = await draftOf(f, 20);
    await submitPending(f, orderId);
    expect(await stepStates(f.app, orderId)).toEqual(['1.1 OPEN', '1.2 OPEN']);
    await as(f.app, f.approver, async (q) => {
      await decide(q, orderId, 1, 'REJECTED', f.approverId);
      await q.query(
        `UPDATE approval_steps SET state = 'VOIDED', voided_at = now()
          WHERE order_id = $1 AND step = 2`,
        [orderId],
      );
      await close(q, orderId, 'REJECTED');
    });
    expect(await stepStates(f.app, orderId)).toEqual(['1.1 REJECTED', '1.2 VOIDED']);
    expect(await readOrder(f.app, orderId)).toMatchObject({ status: 'REJECTED' });
  });

  it('[FR-SM-03] withdraw voids the round (an approval keeps its record) and returns to DRAFT; a resubmit opens round 2', async () => {
    const f = await fixture();
    await twoTierPolicy(f);
    const { orderId } = await draftOf(f, 20);
    await submitPending(f, orderId);
    await as(f.app, f.approver, (q) => decide(q, orderId, 1, 'APPROVED', f.approverId));
    await as(f.app, f.owner_, async (q) => {
      await q.query(
        `UPDATE approval_steps SET state = 'VOIDED', voided_at = now() WHERE order_id = $1`,
        [orderId],
      );
      await q.query(
        `UPDATE approval_rounds SET outcome = 'WITHDRAWN', closed_at = now(),
                withdraw_reason = 'Wrong quantity' WHERE order_id = $1 AND round = 1`,
        [orderId],
      );
      await q.query(
        `UPDATE purchase_orders SET status = 'DRAFT', submitted_at = NULL, version = version + 1
          WHERE id = $1`,
        [orderId],
      );
    });
    const { rows } = await f.app.query<{ decided_by: string | null }>(
      `SELECT decided_by::text FROM approval_steps WHERE order_id = $1 AND step = 1`,
      [orderId],
    );
    expect(rows[0]?.decided_by).toBe(f.approverId);
    expect(await readOrder(f.app, orderId)).toMatchObject({ status: 'DRAFT' });
    await submitPending(f, orderId);
    expect(await stepStates(f.app, orderId)).toEqual([
      '1.1 VOIDED',
      '1.2 VOIDED',
      '2.1 OPEN',
      '2.2 OPEN',
    ]);
  });
});

describe('[FR-SM-01] D1: status, round and chain agree at commit', () => {
  it('[FR-SM-01] APPROVED with an open step is refused at commit', async () => {
    const f = await fixture();
    const { orderId } = await draftOf(f, 2);
    await submitPending(f, orderId);
    expect(
      await sqlstate(() =>
        as(f.app, f.owner_, (q) =>
          q.query(
            `UPDATE purchase_orders SET status = 'APPROVED', approved_at = now() WHERE id = $1`,
            [orderId],
          ),
        ),
      ),
    ).toBe(INCONSISTENT);
  });

  it('[FR-APR-03] a chain that skips or invents a tier, or whose total differs from the order, is refused', async () => {
    const f = await fixture();
    await twoTierPolicy(f);
    // Above both tiers, but only one step.
    const skip = await draftOf(f, 20);
    expect(
      await sqlstate(() =>
        as(f.app, f.owner_, async (q) => {
          await insertSubmission(q, skip.orderId);
          await q.query(`DELETE FROM approval_steps WHERE order_id = $1 AND step = 2`, [
            skip.orderId,
          ]);
          await moveToPending(q, skip.orderId);
        }),
      ),
    ).toBe('42501'); // po_app can't delete a step at all
    expect(
      await sqlstate(() =>
        as(f.app, f.owner_, async (q) => {
          await q.query(
            `INSERT INTO approval_rounds (order_id, round, policy_version, total, vendor_snapshot,
                                          submitted_by)
             SELECT id, 1, 2, total, '{"id":"x","name":"x","contactName":null,"contactEmail":null,
                    "contactPhone":null,"paymentTerms":{}}', owner_id
               FROM purchase_orders WHERE id = $1`,
            [skip.orderId],
          );
          await q.query(
            `INSERT INTO approval_steps (order_id, round, step, tier, threshold)
             VALUES ($1, 1, 1, 1, 100000)`,
            [skip.orderId],
          );
          await moveToPending(q, skip.orderId);
        }),
      ),
    ).toBe(INCONSISTENT);
    // Above the lowest tier, with an extra, invented step.
    const extra = await draftOf(f, 2);
    expect(
      await sqlstate(() =>
        as(f.app, f.owner_, async (q) => {
          await insertSubmission(q, extra.orderId);
          await q.query(
            `INSERT INTO approval_steps (order_id, round, step, tier, threshold)
             VALUES ($1, 1, 2, 2, 1000000)`,
            [extra.orderId],
          );
          await moveToPending(q, extra.orderId);
        }),
      ),
    ).toBe(INCONSISTENT);
    // A round total that isn't the order's.
    const total = await draftOf(f, 2);
    expect(
      await sqlstate(() =>
        as(f.app, f.owner_, async (q) => {
          await q.query(
            `INSERT INTO approval_rounds (order_id, round, policy_version, total, vendor_snapshot,
                                          submitted_by)
             SELECT id, 1, 2, 50000, '{"id":"x","name":"x","contactName":null,"contactEmail":null,
                    "contactPhone":null,"paymentTerms":{}}', owner_id
               FROM purchase_orders WHERE id = $1`,
            [total.orderId],
          );
          await q.query(
            `UPDATE approval_rounds SET outcome = 'AUTO_APPROVED', closed_at = now()
              WHERE order_id = $1`,
            [total.orderId],
          );
        }),
      ),
    ).toBe(ROUND_REFUSED); // a USER context can't record an auto-approval (D6)
    expect(
      await sqlstate(() =>
        as(f.app, { type: 'SYSTEM' }, async (q) => {
          await q.query(
            `INSERT INTO approval_rounds (order_id, round, policy_version, total, vendor_snapshot,
                                          submitted_by)
             SELECT id, 1, 2, 50000, '{"id":"x","name":"x","contactName":null,"contactEmail":null,
                    "contactPhone":null,"paymentTerms":{}}', owner_id
               FROM purchase_orders WHERE id = $1`,
            [total.orderId],
          );
          await q.query(
            `UPDATE approval_rounds SET outcome = 'AUTO_APPROVED', closed_at = now()
              WHERE order_id = $1`,
            [total.orderId],
          );
          await q.query(
            `UPDATE purchase_orders SET status = 'APPROVED', current_round = 1,
                    submitted_at = now(), approved_at = now() WHERE id = $1`,
            [total.orderId],
          );
        }),
      ),
    ).toBe(INCONSISTENT);
  });

  it('[FR-APR-01] DRAFT → APPROVED above the threshold with no step (a hand-made auto-approval) is refused', async () => {
    const f = await fixture();
    const { orderId } = await draftOf(f, 2);
    expect(
      await sqlstate(() =>
        as(f.app, { type: 'SYSTEM' }, async (q) => {
          await q.query(
            `INSERT INTO approval_rounds (order_id, round, policy_version, total, vendor_snapshot,
                                          submitted_by)
             SELECT id, 1, 1, total, '{"id":"x","name":"x","contactName":null,"contactEmail":null,
                    "contactPhone":null,"paymentTerms":{}}', owner_id
               FROM purchase_orders WHERE id = $1`,
            [orderId],
          );
          await q.query(
            `UPDATE approval_rounds SET outcome = 'AUTO_APPROVED', closed_at = now()
              WHERE order_id = $1`,
            [orderId],
          );
          await q.query(
            `UPDATE purchase_orders SET status = 'APPROVED', current_round = 1,
                    submitted_at = now(), approved_at = now() WHERE id = $1`,
            [orderId],
          );
        }),
      ),
    ).toBe(INCONSISTENT);
  });

  it('[FR-SM-01] a submitted order with no round is refused', async () => {
    const f = await fixture();
    const { orderId } = await draftOf(f, 1);
    expect(
      await sqlstate(() =>
        as(f.app, f.owner_, (q) =>
          q.query(
            `UPDATE purchase_orders SET status = 'PENDING_APPROVAL', submitted_at = now()
              WHERE id = $1`,
            [orderId],
          ),
        ),
      ),
    ).toBe(INCONSISTENT);
  });
});

describe('[FR-SM-01] D2, D5: a decision is on the current step, by the acting user, never the owner', () => {
  it('[FR-SM-01] step 2 while step 1 is open is refused', async () => {
    const f = await fixture();
    await twoTierPolicy(f);
    const { orderId } = await draftOf(f, 20);
    await submitPending(f, orderId);
    expect(
      await sqlstate(() =>
        as(f.app, f.approver, (q) => decide(q, orderId, 2, 'APPROVED', f.approverId)),
      ),
    ).toBe(STEP_REFUSED);
  });

  it('[FR-SOD-01] a step decided by the owner, or by anyone but the acting user, is refused', async () => {
    const f = await fixture();
    const { orderId } = await draftOf(f, 2);
    await submitPending(f, orderId);
    const ownerAndApprover: Actor = { type: 'USER', userId: f.buyerId, role: 'APPROVER' };
    expect(
      await sqlstate(() =>
        as(f.app, ownerAndApprover, (q) => decide(q, orderId, 1, 'APPROVED', f.buyerId)),
      ),
    ).toBe(SELF_DECISION);
    expect(
      await sqlstate(() =>
        as(f.app, f.approver, (q) => decide(q, orderId, 1, 'APPROVED', randomUUID())),
      ),
    ).toBe(SELF_DECISION);
    expect(
      await sqlstate(() =>
        as(f.app, { type: 'SYSTEM' }, (q) => decide(q, orderId, 1, 'APPROVED', f.approverId)),
      ),
    ).toBe(SELF_DECISION);
  });

  it('[FR-SM-01] a decision against a stale order version is refused', async () => {
    const f = await fixture();
    const { orderId } = await draftOf(f, 2);
    await submitPending(f, orderId);
    expect(
      await sqlstate(() =>
        as(f.app, f.approver, (q) =>
          q.query(
            `UPDATE approval_steps SET state = 'APPROVED', decided_by = $2, decided_at = now(),
                    decided_version = 1
              WHERE order_id = $1`,
            [orderId, f.approverId],
          ),
        ),
      ),
    ).toBe(STEP_REFUSED);
  });
});

describe('[FR-SM-01] D4, D6, D7: rounds and steps are written only in turn, and never after', () => {
  it('[FR-SM-01] a closed round and its steps never change; nothing of an existing order is deleted', async () => {
    const f = await fixture();
    const { orderId } = await draftOf(f, 2);
    await submitPending(f, orderId);
    await as(f.app, f.approver, async (q) => {
      await decide(q, orderId, 1, 'APPROVED', f.approverId);
      await close(q, orderId, 'APPROVED');
    });
    const asOwnerRole = (sql: string) =>
      sqlstate(() => as(f.owner, { type: 'SYSTEM' }, (q) => q.query(sql, [orderId])));
    expect(
      await asOwnerRole(
        `UPDATE approval_steps SET state = 'VOIDED', voided_at = now() WHERE order_id = $1`,
      ),
    ).toBe(STEP_REFUSED);
    expect(await asOwnerRole(`UPDATE approval_steps SET threshold = 1 WHERE order_id = $1`)).toBe(
      STEP_REFUSED,
    );
    expect(
      await asOwnerRole(`UPDATE approval_rounds SET outcome = 'REJECTED' WHERE order_id = $1`),
    ).toBe(ROUND_REFUSED);
    expect(await asOwnerRole(`UPDATE approval_rounds SET total = 1 WHERE order_id = $1`)).toBe(
      ROUND_REFUSED,
    );
    expect(await asOwnerRole(`DELETE FROM approval_steps WHERE order_id = $1`)).toBe(STEP_REFUSED);
    expect(await asOwnerRole(`DELETE FROM approval_rounds WHERE order_id = $1`)).toBe(
      ROUND_REFUSED,
    );
  });

  it('[FR-SM-01] AUTO_APPROVED is recorded only by SYSTEM', async () => {
    const f = await fixture();
    const { orderId } = await draftOf(f, 1);
    expect(
      await sqlstate(() =>
        as(f.app, f.owner_, async (q) => {
          await insertSubmission(q, orderId);
          await q.query(
            `UPDATE approval_rounds SET outcome = 'AUTO_APPROVED', closed_at = now()
              WHERE order_id = $1`,
            [orderId],
          );
        }),
      ),
    ).toBe(ROUND_REFUSED);
  });

  it('[FR-SM-01] a round or step is inserted only for a draft, as its next round, open', async () => {
    const f = await fixture();
    const { orderId } = await draftOf(f, 2);
    await submitPending(f, orderId);
    // Pending: no further round, no step added to the open one.
    expect(await sqlstate(() => as(f.app, f.owner_, (q) => insertSubmission(q, orderId)))).toBe(
      ROUND_REFUSED,
    );
    expect(
      await sqlstate(() =>
        as(f.app, f.owner_, (q) =>
          q.query(
            `INSERT INTO approval_steps (order_id, round, step, tier, threshold)
             VALUES ($1, 1, 2, 2, 1000000)`,
            [orderId],
          ),
        ),
      ),
    ).toBe(STEP_REFUSED);
    // A draft's round must be its next one, and its steps must start open.
    const draft = await draftOf(f, 2);
    expect(
      await sqlstate(() =>
        as(f.app, f.owner_, (q) =>
          q.query(
            `INSERT INTO approval_rounds (order_id, round, policy_version, total, vendor_snapshot,
                                          submitted_by)
             SELECT id, 3, 1, total, '{"id":"x","name":"x","contactName":null,"contactEmail":null,
                    "contactPhone":null,"paymentTerms":{}}', owner_id
               FROM purchase_orders WHERE id = $1`,
            [draft.orderId],
          ),
        ),
      ),
    ).toBe(ROUND_REFUSED);
    expect(
      await sqlstate(() =>
        as(f.owner, f.owner_, async (q) => {
          await insertSubmission(q, draft.orderId);
          await q.query(
            `INSERT INTO approval_steps (order_id, round, step, tier, threshold, state, decided_by,
                                         decided_at, decided_version)
             VALUES ($1, 1, 9, 1, 100000, 'APPROVED', $2, now(), 1)`,
            [draft.orderId, f.approverId],
          );
        }),
      ),
    ).toBe(STEP_REFUSED);
  });
});

describe('[FR-LCK-01] D8: a submitted order keeps its vendor and submission', () => {
  it('[FR-LCK-01] the vendor, submitted_at, approved_at and current_round change only with a transition', async () => {
    const f = await fixture();
    const { orderId, lineIds } = await draftOf(f, 2);
    await submitPending(f, orderId);
    const otherVendor = randomUUID();
    await inTransaction(f.app, (q) =>
      q.query(
        `INSERT INTO vendors (id, name, contact_name, contact_email, payment_term_type, net_days)
         VALUES ($1, $2, 'Ravi Shah', 'ravi@acme.example', 'NET', 30)`,
        [otherVendor, `Other ${otherVendor}`],
      ),
    );
    const change = (sql: string, params: unknown[] = []) =>
      sqlstate(() => as(f.app, f.owner_, (q) => q.query(sql, [orderId, ...params])));
    expect(
      await change(`UPDATE purchase_orders SET vendor_id = $2 WHERE id = $1`, [otherVendor]),
    ).toBe(SUBMISSION_LOCKED);
    expect(
      await change(
        `UPDATE purchase_orders SET submitted_at = now() - interval '1 day' WHERE id = $1`,
      ),
    ).toBe(SUBMISSION_LOCKED);
    expect(await change(`UPDATE purchase_orders SET current_round = 2 WHERE id = $1`)).toBe(
      SUBMISSION_LOCKED,
    );
    expect(await change(`UPDATE purchase_orders SET approved_at = now() WHERE id = $1`)).toBe(
      SUBMISSION_LOCKED,
    );
    // Lines stay locked as in slice 3; a status outside the table stays refused.
    expect(
      await sqlstate(() =>
        as(f.app, f.owner_, (q) =>
          q.query(`UPDATE order_lines SET quantity = 1 WHERE id = $1`, [lineIds[0]]),
        ),
      ),
    ).toBe(ORDER_LINES_LOCKED);
    expect(await change(`UPDATE purchase_orders SET status = 'CANCELLED' WHERE id = $1`)).toBe(
      ORDER_STATUS_TRANSITION_REFUSED,
    );
  });

  it('[FR-LCK-01] a draft still changes its vendor freely', async () => {
    const f = await fixture();
    const { orderId } = await draftOf(f, 1);
    const vendor = randomUUID();
    await inTransaction(f.app, (q) =>
      q.query(
        `INSERT INTO vendors (id, name, contact_name, contact_email, payment_term_type, net_days)
         VALUES ($1, $2, 'Ravi Shah', 'ravi@acme.example', 'NET', 30)`,
        [vendor, `Other ${vendor}`],
      ),
    );
    await as(f.app, f.owner_, (q) =>
      q.query(`UPDATE purchase_orders SET vendor_id = $2, version = version + 1 WHERE id = $1`, [
        orderId,
        vendor,
      ]),
    );
  });
});

describe('[FR-APR-05] the policy is immutable and written only by the operator function', () => {
  it('[FR-APR-05] set_approval_policy needs the OPERATOR context and valid tiers', async () => {
    const f = await fixture();
    const set = (actor: Actor, tiers: string) =>
      sqlstate(() =>
        as(f.app, actor, (q) => q.query(`SELECT set_approval_policy($1::numeric[])`, [tiers])),
      );
    expect(await set(f.owner_, '{200000}')).toBe(POLICY_IMMUTABLE);
    expect(await set({ type: 'SYSTEM' }, '{200000}')).toBe(POLICY_IMMUTABLE);
    for (const bad of ['{}', '{0}', '{-1}', '{100000.00001}', '{200000,100000}', '{1,1}']) {
      expect(await set({ type: 'OPERATOR' }, bad), bad).toBe(POLICY_IMMUTABLE);
    }
    const version = await as(f.app, { type: 'OPERATOR' }, (q) =>
      q.query<{ v: number }>(`SELECT set_approval_policy('{200000}') AS v`),
    );
    expect(version.rows[0]?.v).toBe(2);
    // The current tiers again: no new version.
    const same = await as(f.app, { type: 'OPERATOR' }, (q) =>
      q.query<{ v: number }>(`SELECT set_approval_policy('{200000.0000}') AS v`),
    );
    expect(same.rows[0]?.v).toBe(2);
    const { rows } = await f.app.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM approval_policies`,
    );
    expect(rows[0]?.n).toBe(2);
  });

  it('[FR-APR-05] a policy row never changes, even for the owner role', async () => {
    const f = await fixture();
    const asOwnerRole = (sql: string) =>
      sqlstate(() => as(f.owner, { type: 'OPERATOR' }, (q) => q.query(sql)));
    expect(await asOwnerRole(`UPDATE approval_policy_tiers SET threshold = 1`)).toBe(
      POLICY_IMMUTABLE,
    );
    expect(await asOwnerRole(`DELETE FROM approval_policy_tiers`)).toBe(POLICY_IMMUTABLE);
    expect(await asOwnerRole(`UPDATE approval_policies SET effective_at = now()`)).toBe(
      POLICY_IMMUTABLE,
    );
    expect(await asOwnerRole(`DELETE FROM approval_policies`)).toBe(POLICY_IMMUTABLE);
  });
});

describe('[FR-SM-01] a bare status change has no submission', () => {
  it('[FR-SM-01] status alone is refused by the submission CHECK', async () => {
    const f = await fixture();
    const { orderId } = await draftOf(f, 1);
    expect(
      await sqlstate(() =>
        as(f.app, f.owner_, (q) =>
          q.query(`UPDATE purchase_orders SET status = 'PENDING_APPROVAL' WHERE id = $1`, [
            orderId,
          ]),
        ),
      ),
    ).toBe(CHECK_VIOLATION);
  });
});

// Migration 0015, part 2 (specs/006-lock-cancel/research.md R2, D9–D11): a rejected or
// cancelled order never changes; the cancel record is written only by the cancel, which
// changes nothing else, by the acting user and never the owner.

/** The cancel's statement as po_app, inside the caller's transaction. */
async function cancelOrder(
  q: pg.Client,
  orderId: string,
  by: string | null,
  extra = '',
): Promise<void> {
  await q.query(
    `UPDATE purchase_orders
        SET status = 'CANCELLED', cancelled_by = $2, cancel_reason = 'Not needed',
            version = version + 1${extra}
      WHERE id = $1`,
    [orderId, by],
  );
}

/** An approved order, planted: routed by the Approver when its total exceeds the tier. */
async function approved(f: Fixture, quantity = 2): Promise<string> {
  const { orderId } = await draftOf(f, quantity);
  await plantSubmitted(f, orderId, 'APPROVED', { approverId: f.approverId });
  return orderId;
}

describe('[FR-LCK-02] the cancel transition in the database', () => {
  it('[FR-LCK-02] an Approver cancels an approved order: the record is kept, cancelled_at the database clock', async () => {
    const f = await fixture();
    const orderId = await approved(f);
    const before = await readOrder(f.app, orderId);
    await as(f.app, f.approver, (q) => cancelOrder(q, orderId, f.approverId));
    expect(await readOrder(f.app, orderId)).toMatchObject({
      status: 'CANCELLED',
      version: (before?.version ?? 0) + 1,
    });
    const { rows } = await f.app.query<{ by: string; reason: string; fresh: boolean }>(
      `SELECT cancelled_by AS by, cancel_reason AS reason,
              cancelled_at BETWEEN now() - interval '1 minute' AND now() AS fresh
         FROM purchase_orders WHERE id = $1`,
      [orderId],
    );
    expect(rows[0]).toEqual({ by: f.approverId, reason: 'Not needed', fresh: true });
  });

  it('[FR-LCK-02] an auto-approved order is cancelled the same way', async () => {
    const f = await fixture();
    const { orderId } = await createDraft(f, [{ quantity: 1, unitPrice: '10' }]);
    await plantSubmitted(f, orderId, 'APPROVED', { approverId: f.approverId });
    await as(f.app, f.approver, (q) => cancelOrder(q, orderId, f.approverId));
    expect(await readOrder(f.app, orderId)).toMatchObject({ status: 'CANCELLED' });
  });

  it('[FR-SOD-01] the cancel is by the acting user, never the owner nor SYSTEM', async () => {
    const f = await fixture();
    const orderId = await approved(f);
    const otherApprover = randomUUID();
    await inTransaction(f.app, (q) =>
      q.query(
        `INSERT INTO users (id, name, email, roles, status)
         VALUES ($1, 'Other Approver', $2, '{APPROVER}', 'ACTIVE')`,
        [otherApprover, `approver-${otherApprover}@example.test`],
      ),
    );
    const attempt = (actor: Actor, by: string) =>
      sqlstate(() => as(f.app, actor, (q) => cancelOrder(q, orderId, by)));
    expect(await attempt(f.owner_, f.buyerId)).toBe(SELF_DECISION);
    expect(await attempt(f.approver, f.buyerId)).toBe(SELF_DECISION);
    expect(await attempt(f.approver, otherApprover)).toBe(SELF_DECISION);
    expect(await attempt({ type: 'SYSTEM' }, f.approverId)).toBe(SELF_DECISION);
    expect(await readOrder(f.app, orderId)).toMatchObject({ status: 'APPROVED' });
  });

  it('[FR-LCK-02] the record is written only by the cancel, which changes nothing else', async () => {
    const f = await fixture();
    const orderId = await approved(f);
    const other = await createDraft(f, [{ quantity: 1, unitPrice: '1' }]);
    const attempt = (sql: string, params: unknown[] = []) =>
      sqlstate(() => as(f.app, f.approver, (q) => q.query(sql, [orderId, ...params])));
    // The record without the status.
    expect(
      await attempt(`UPDATE purchase_orders SET cancel_reason = 'Not needed' WHERE id = $1`),
    ).toBe(CANCEL_REFUSED);
    expect(
      await attempt(`UPDATE purchase_orders SET cancelled_by = $2 WHERE id = $1`, [f.approverId]),
    ).toBe(CANCEL_REFUSED);
    // The cancel changing anything but the status, the version (+1) and the record.
    const cancelWith = (extra: string, params: unknown[] = []) =>
      sqlstate(() =>
        as(f.app, f.approver, (q) =>
          q.query(
            `UPDATE purchase_orders
                SET status = 'CANCELLED', cancelled_by = $2, cancel_reason = 'Not needed'${extra}
              WHERE id = $1`,
            [orderId, f.approverId, ...params],
          ),
        ),
      );
    expect(await cancelWith(``)).toBe(CANCEL_REFUSED);
    expect(await cancelWith(`, version = version + 2`)).toBe(CANCEL_REFUSED);
    expect(
      await cancelWith(`, version = version + 1, submitted_at = now() - interval '1 day'`),
    ).toBe(CANCEL_REFUSED);
    expect(
      await cancelWith(`, version = version + 1, approved_at = now() - interval '1 day'`),
    ).toBe(CANCEL_REFUSED);
    expect(await cancelWith(`, version = version + 1, po_number = NULL`)).toBe(CANCEL_REFUSED);
    // Without its record the status is refused by the CHECK (cancelled_at is the guard's).
    expect(
      await sqlstate(() =>
        as(f.app, f.approver, (q) =>
          q.query(
            `UPDATE purchase_orders SET status = 'CANCELLED', version = version + 1 WHERE id = $1`,
            [orderId],
          ),
        ),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(await readOrder(f.app, orderId)).toMatchObject({ status: 'APPROVED' });
    // A draft can't be cancelled: no transition.
    expect(
      await sqlstate(() =>
        as(f.app, f.approver, (q) => cancelOrder(q, other.orderId, f.approverId)),
      ),
    ).toBe(ORDER_STATUS_TRANSITION_REFUSED);
  });
});

describe('[FR-LCK-01] a rejected or cancelled order never changes', () => {
  it('[FR-LCK-01] every column of a cancelled order is refused, its record and version included', async () => {
    const f = await fixture();
    const orderId = await approved(f);
    await as(f.app, f.approver, (q) => cancelOrder(q, orderId, f.approverId));
    const attempt = (sql: string, actor: Actor = f.approver) =>
      sqlstate(() => as(f.app, actor, (q) => q.query(sql, [orderId])));
    expect(await attempt(`UPDATE purchase_orders SET version = version + 1 WHERE id = $1`)).toBe(
      ORDER_CLOSED,
    );
    expect(
      await attempt(`UPDATE purchase_orders SET cancel_reason = 'Changed' WHERE id = $1`),
    ).toBe(ORDER_CLOSED);
    expect(await attempt(`UPDATE purchase_orders SET cancelled_by = owner_id WHERE id = $1`)).toBe(
      ORDER_CLOSED,
    );
    expect(await attempt(`UPDATE purchase_orders SET status = 'APPROVED' WHERE id = $1`)).toBe(
      ORDER_CLOSED,
    );
    expect(
      await attempt(`UPDATE purchase_orders SET vendor_id = vendor_id WHERE id = $1`, f.owner_),
    ).toBe(ORDER_CLOSED);
    // Its lines, round and steps, and deleting it, stay refused by the slice 3–4 rules.
    expect(
      await attempt(`UPDATE order_lines SET quantity = quantity + 1 WHERE order_id = $1`, f.owner_),
    ).toBe(ORDER_LINES_LOCKED);
    expect(await attempt(`UPDATE approval_rounds SET closed_at = now() WHERE order_id = $1`)).toBe(
      ROUND_REFUSED,
    );
    expect(
      await attempt(
        `UPDATE approval_steps SET state = 'VOIDED', voided_at = now() WHERE order_id = $1`,
      ),
    ).toBe(STEP_REFUSED);
    expect(await attempt(`DELETE FROM purchase_orders WHERE id = $1`, f.owner_)).toBe(
      ORDER_DELETE_REFUSED,
    );
  });

  it('[FR-LCK-01] a rejected order is final in the database too: status and version included', async () => {
    const f = await fixture();
    const { orderId } = await draftOf(f, 2);
    await plantSubmitted(f, orderId, 'REJECTED', { approverId: f.approverId });
    const attempt = (sql: string) =>
      sqlstate(() => as(f.app, f.approver, (q) => q.query(sql, [orderId])));
    expect(await attempt(`UPDATE purchase_orders SET version = version + 1 WHERE id = $1`)).toBe(
      ORDER_CLOSED,
    );
    expect(
      await attempt(`UPDATE purchase_orders SET status = 'PENDING_APPROVAL' WHERE id = $1`),
    ).toBe(ORDER_CLOSED);
    expect(await attempt(`UPDATE purchase_orders SET vendor_id = vendor_id WHERE id = $1`)).toBe(
      ORDER_CLOSED,
    );
  });

  it('[FR-LCK-01] the owner role, past every grant, is refused the same way', async () => {
    const f = await fixture();
    const { orderId } = await draftOf(f, 2);
    await plantCancelled(f, orderId, { approverId: f.approverId });
    const asOwnerRole = (sql: string) =>
      sqlstate(() => as(f.owner, f.approver, (q) => q.query(sql, [orderId])));
    expect(await asOwnerRole(`UPDATE purchase_orders SET cancelled_at = now() WHERE id = $1`)).toBe(
      ORDER_CLOSED,
    );
    expect(await asOwnerRole(`UPDATE purchase_orders SET version = 1 WHERE id = $1`)).toBe(
      ORDER_CLOSED,
    );
  });
});

describe('[FR-SM-01] the commit-time check covers cancelled orders', () => {
  it('[FR-SM-01] a cancelled order is consistent when its round closed approved, and not otherwise', async () => {
    const f = await fixture();
    const inconsistency = async (orderId: string) => {
      const { rows } = await f.app.query<{ problem: string | null }>(
        `SELECT approval_inconsistency($1) AS problem`,
        [orderId],
      );
      return rows[0]?.problem ?? null;
    };
    const stepApproved = await draftOf(f, 2);
    await plantCancelled(f, stepApproved.orderId, { approverId: f.approverId });
    expect(await inconsistency(stepApproved.orderId)).toBeNull();
    const auto = await createDraft(f, [{ quantity: 1, unitPrice: '10' }]);
    await plantCancelled(f, auto.orderId, { approverId: f.approverId });
    expect(await inconsistency(auto.orderId)).toBeNull();

    // Planted below the guards on purpose: a cancelled order whose round was rejected, and
    // one whose approved_at isn't its round's close.
    plantsViolations(f.db);
    const rejected = await draftOf(f, 2);
    await plantSubmitted(f, rejected.orderId, 'REJECTED', { approverId: f.approverId });
    await plant(
      f,
      `UPDATE purchase_orders SET status = 'CANCELLED', approved_at = now(), cancelled_by = $2,
              cancelled_at = now(), cancel_reason = 'Planted' WHERE id = $1`,
      [rejected.orderId, f.approverId],
    );
    expect(await inconsistency(rejected.orderId)).toMatch(/^cancelled with round REJECTED/);
    const moved = await draftOf(f, 2);
    await plantCancelled(f, moved.orderId, { approverId: f.approverId });
    await plant(
      f,
      `UPDATE purchase_orders SET approved_at = approved_at - interval '1 day' WHERE id = $1`,
      [moved.orderId],
    );
    expect(await inconsistency(moved.orderId)).toBe("approved_at is not the round's close");
  });
});

describe('[FR-SM-01] the database allows T10 from APPROVED only', () => {
  it('[FR-SM-01] a full cancel from draft or pending is PO009; from rejected or cancelled PO018', async () => {
    const f = await fixture();
    const draft = (await draftOf(f, 2)).orderId;
    const pending = (await draftOf(f, 2)).orderId;
    await plantSubmitted(f, pending, 'PENDING_APPROVAL', { approverId: f.approverId });
    const rejected = (await draftOf(f, 2)).orderId;
    await plantSubmitted(f, rejected, 'REJECTED', { approverId: f.approverId });
    const cancelled = (await draftOf(f, 2)).orderId;
    await plantCancelled(f, cancelled, { approverId: f.approverId });
    const attempt = (orderId: string) =>
      sqlstate(() => as(f.app, f.approver, (q) => cancelOrder(q, orderId, f.approverId)));
    expect(await attempt(draft)).toBe(ORDER_STATUS_TRANSITION_REFUSED);
    expect(await attempt(pending)).toBe(ORDER_STATUS_TRANSITION_REFUSED);
    expect(await attempt(rejected)).toBe(ORDER_CLOSED);
    expect(await attempt(cancelled)).toBe(ORDER_CLOSED);
    expect(await attempt(await approved(f))).toBeUndefined();
  });
});
