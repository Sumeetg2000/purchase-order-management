import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  CHECK_VIOLATION,
  INSUFFICIENT_PRIVILEGE,
  createDraft,
  orderFixture,
  plant,
  sqlstate,
} from '../support/orders-sql.js';

// Migration 0014, part 1 (specs/005-submit-approve/data-model.md): the approval policy,
// round and step tables, the submission columns on purchase_orders, the slice 4
// transitions, grants, indexes and the seeded policy. The guards and the commit-time
// consistency check are part 2, tested by approval-triggers.test.ts.

async function columnPrivileges(
  q: pg.Client,
  table: string,
  privilege: 'INSERT' | 'UPDATE',
): Promise<string[]> {
  const { rows } = await q.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
        AND has_column_privilege('po_app', format('public.%I', table_name), column_name, $2)
      ORDER BY column_name`,
    [table, privilege],
  );
  return rows.map((r) => r.column_name);
}

async function tablePrivileges(q: pg.Client, role: string, table: string): Promise<string[]> {
  const held: string[] = [];
  for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
    const { rows } = await q.query<{ ok: boolean }>(
      `SELECT has_table_privilege($1, $2, $3) AS ok`,
      [role, `public.${table}`, privilege],
    );
    if (rows[0]?.ok === true) held.push(privilege);
  }
  return held;
}

async function constraintNames(q: pg.Client, table: string): Promise<string[]> {
  const { rows } = await q.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY conname`,
    [`public.${table}`],
  );
  return rows.map((r) => r.conname);
}

const SNAPSHOT = {
  id: randomUUID(),
  name: 'Acme',
  contactName: null,
  contactEmail: null,
  contactPhone: null,
  paymentTerms: { type: 'NET', netDays: 30 },
};

/** Plants a round row for a draft as the superuser (part 1: no guards yet). */
async function plantRound(
  f: Awaited<ReturnType<typeof orderFixture>>,
  orderId: string,
  columns: Record<string, unknown>,
): Promise<string | undefined> {
  const row = {
    order_id: orderId,
    round: 1,
    policy_version: 1,
    total: '1.0000',
    vendor_snapshot: JSON.stringify(SNAPSHOT),
    submitted_by: f.buyerId,
    ...columns,
  };
  const names = Object.keys(row);
  return sqlstate(() =>
    plant(
      f,
      `INSERT INTO approval_rounds (${names.join(', ')})
       VALUES (${names.map((_, i) => `$${String(i + 1)}`).join(', ')})`,
      Object.values(row),
    ),
  );
}

describe('[FR-SM-01] migration 0014: approval tables', () => {
  it('[FR-SM-01] po_app holds exactly the planned grants on the approval tables', async () => {
    const { superuser: q } = await orderFixture();
    expect(await tablePrivileges(q, 'po_app', 'approval_policies')).toEqual(['SELECT']);
    expect(await tablePrivileges(q, 'po_app', 'approval_policy_tiers')).toEqual(['SELECT']);

    expect(await tablePrivileges(q, 'po_app', 'approval_rounds')).toEqual(['SELECT']);
    expect(await columnPrivileges(q, 'approval_rounds', 'INSERT')).toEqual([
      'order_id',
      'policy_version',
      'round',
      'submitted_by',
      'total',
      'vendor_snapshot',
    ]);
    expect(await columnPrivileges(q, 'approval_rounds', 'UPDATE')).toEqual([
      'closed_at',
      'outcome',
      'withdraw_reason',
    ]);

    expect(await tablePrivileges(q, 'po_app', 'approval_steps')).toEqual(['SELECT']);
    expect(await columnPrivileges(q, 'approval_steps', 'INSERT')).toEqual([
      'order_id',
      'round',
      'step',
      'threshold',
      'tier',
    ]);
    expect(await columnPrivileges(q, 'approval_steps', 'UPDATE')).toEqual([
      'decided_at',
      'decided_by',
      'decided_version',
      'reason',
      'state',
      'voided_at',
    ]);
    for (const table of [
      'approval_policies',
      'approval_policy_tiers',
      'approval_rounds',
      'approval_steps',
    ]) {
      expect(await tablePrivileges(q, 'po_maintenance', table), table).toEqual([]);
    }
  });

  it('[FR-APR-05] the seeded policy is version 1 with exactly one tier at 100000.0000, and no audit entry', async () => {
    const { app } = await orderFixture();
    const { rows: tiers } = await app.query<{
      policy_version: number;
      tier: number;
      threshold: string;
    }>(
      `SELECT policy_version, tier, threshold::text AS threshold FROM approval_policy_tiers
        ORDER BY policy_version, tier`,
    );
    expect(tiers).toEqual([{ policy_version: 1, tier: 1, threshold: '100000.0000' }]);
    // The seed is migration data, like the transition rows: no actor changed a policy, so
    // no entry is written (research R1). Every later policy:set is audited.
    const { rows: entries } = await app.query(
      `SELECT 1 FROM audit_entries WHERE action = 'APPROVAL_POLICY_CHANGED'`,
    );
    expect(entries).toEqual([]);
  });

  it('[FR-SM-01] the slice 4 transitions are exactly T4, T5, T7, T8 and T9', async () => {
    const { app } = await orderFixture();
    const { rows } = await app.query<{ from_status: string; to_status: string }>(
      `SELECT from_status, to_status FROM order_status_transitions ORDER BY 1, 2`,
    );
    expect(rows).toEqual([
      { from_status: 'DRAFT', to_status: 'APPROVED' },
      { from_status: 'DRAFT', to_status: 'PENDING_APPROVAL' },
      { from_status: 'PENDING_APPROVAL', to_status: 'APPROVED' },
      { from_status: 'PENDING_APPROVAL', to_status: 'DRAFT' },
      { from_status: 'PENDING_APPROVAL', to_status: 'REJECTED' },
    ]);
  });

  it('[FR-SM-01] the named CHECKs and keys exist on each table', async () => {
    const { superuser: q } = await orderFixture();
    expect(await constraintNames(q, 'approval_policies')).toEqual([
      'approval_policies_pkey',
      'approval_policies_version_positive',
    ]);
    expect(await constraintNames(q, 'approval_policy_tiers')).toEqual([
      'approval_policy_tiers_pkey',
      'approval_policy_tiers_policy_version_fkey',
      'approval_policy_tiers_threshold_positive',
      'approval_policy_tiers_tier_positive',
    ]);
    expect(await constraintNames(q, 'approval_rounds')).toEqual([
      'approval_rounds_closed_matches_outcome',
      'approval_rounds_order_id_fkey',
      'approval_rounds_outcome_valid',
      'approval_rounds_pkey',
      'approval_rounds_policy_version_fkey',
      'approval_rounds_round_positive',
      'approval_rounds_submitted_by_fkey',
      'approval_rounds_total_nonnegative',
      'approval_rounds_vendor_snapshot_shape',
      'approval_rounds_withdraw_reason_matches_outcome',
      'approval_rounds_withdraw_reason_valid',
    ]);
    expect(await constraintNames(q, 'approval_steps')).toEqual([
      'approval_steps_decided_by_fkey',
      'approval_steps_decided_version_positive',
      'approval_steps_order_id_round_fkey',
      'approval_steps_pkey',
      'approval_steps_reason_valid',
      'approval_steps_state_shape',
      'approval_steps_state_valid',
      'approval_steps_step_positive',
      'approval_steps_threshold_positive',
      'approval_steps_tier_positive',
    ]);
    const orders = await constraintNames(q, 'purchase_orders');
    expect(orders).toEqual(
      expect.arrayContaining([
        'purchase_orders_approved_matches_status',
        'purchase_orders_current_round_fkey',
        'purchase_orders_current_round_positive',
        'purchase_orders_submitted_matches_status',
      ]),
    );
  });

  it('[FR-SM-01] round CHECKs refuse a bad outcome, an unpaired close and a stray reason', async () => {
    const f = await orderFixture();
    const { orderId } = await createDraft(f, [{ quantity: 1, unitPrice: '1' }]);
    expect(await plantRound(f, orderId, { outcome: 'LOST', closed_at: new Date() })).toBe(
      CHECK_VIOLATION,
    );
    expect(await plantRound(f, orderId, { outcome: 'APPROVED' })).toBe(CHECK_VIOLATION);
    expect(await plantRound(f, orderId, { closed_at: new Date() })).toBe(CHECK_VIOLATION);
    expect(
      await plantRound(f, orderId, {
        outcome: 'REJECTED',
        closed_at: new Date(),
        withdraw_reason: 'Wrong vendor',
      }),
    ).toBe(CHECK_VIOLATION);
    expect(await plantRound(f, orderId, { outcome: 'WITHDRAWN', closed_at: new Date() })).toBe(
      CHECK_VIOLATION,
    );
    expect(
      await plantRound(f, orderId, {
        outcome: 'WITHDRAWN',
        closed_at: new Date(),
        withdraw_reason: ' padded ',
      }),
    ).toBe(CHECK_VIOLATION);
    expect(
      await plantRound(f, orderId, { vendor_snapshot: JSON.stringify({ name: 'Acme' }) }),
    ).toBe(CHECK_VIOLATION);
    expect(await plantRound(f, orderId, { round: 0 })).toBe(CHECK_VIOLATION);
    expect(await plantRound(f, orderId, {})).toBeUndefined();
    expect(
      await plantRound(f, orderId, {
        round: 2,
        outcome: 'WITHDRAWN',
        closed_at: new Date(),
        withdraw_reason: 'Wrong vendor',
      }),
    ).toBeUndefined();
  });

  it('[FR-SM-01] each step state has exactly its decision and void columns', async () => {
    const f = await orderFixture();
    const { orderId } = await createDraft(f, [{ quantity: 1, unitPrice: '1' }]);
    expect(await plantRound(f, orderId, {})).toBeUndefined();
    const at = new Date();
    const step = (n: number, columns: Record<string, unknown>) => {
      const row = {
        order_id: orderId,
        round: 1,
        step: n,
        tier: 1,
        threshold: '100000',
        ...columns,
      };
      const names = Object.keys(row);
      return sqlstate(() =>
        plant(
          f,
          `INSERT INTO approval_steps (${names.join(', ')})
           VALUES (${names.map((_, i) => `$${String(i + 1)}`).join(', ')})`,
          Object.values(row),
        ),
      );
    };
    const decision = { decided_by: f.buyerId, decided_at: at, decided_version: 2 };
    expect(await step(1, {})).toBeUndefined();
    expect(await step(2, { state: 'OPEN', decided_at: at })).toBe(CHECK_VIOLATION);
    expect(await step(3, { state: 'APPROVED' })).toBe(CHECK_VIOLATION);
    expect(await step(4, { state: 'APPROVED', ...decision })).toBeUndefined();
    expect(await step(5, { state: 'APPROVED', ...decision, reason: 'x' })).toBe(CHECK_VIOLATION);
    expect(await step(6, { state: 'REJECTED', ...decision })).toBe(CHECK_VIOLATION);
    expect(await step(7, { state: 'REJECTED', ...decision, reason: 'Too dear' })).toBeUndefined();
    expect(await step(8, { state: 'VOIDED' })).toBe(CHECK_VIOLATION);
    expect(await step(9, { state: 'VOIDED', voided_at: at })).toBeUndefined();
    expect(await step(10, { state: 'VOIDED', voided_at: at, ...decision })).toBeUndefined();
    expect(await step(11, { state: 'VOIDED', voided_at: at, decided_by: f.buyerId })).toBe(
      CHECK_VIOLATION,
    );
    expect(await step(12, { state: 'SKIPPED' })).toBe(CHECK_VIOLATION);
    expect(await step(13, { threshold: '0' })).toBe(CHECK_VIOLATION);
  });

  it('[FR-SM-01] an order is submitted exactly when it is not a draft, approved when approved', async () => {
    const f = await orderFixture();
    const { orderId } = await createDraft(f, [{ quantity: 1, unitPrice: '1' }]);
    const set = (sql: string) => sqlstate(() => plant(f, sql, [orderId]));
    expect(await set(`UPDATE purchase_orders SET status = 'PENDING_APPROVAL' WHERE id = $1`)).toBe(
      CHECK_VIOLATION,
    );
    expect(await set(`UPDATE purchase_orders SET submitted_at = now() WHERE id = $1`)).toBe(
      CHECK_VIOLATION,
    );
    expect(
      await set(
        `UPDATE purchase_orders SET status = 'APPROVED', submitted_at = now() WHERE id = $1`,
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await set(
        `UPDATE purchase_orders SET status = 'PENDING_APPROVAL', submitted_at = now(),
                approved_at = now() WHERE id = $1`,
      ),
    ).toBe(CHECK_VIOLATION);
    expect(await plantRound(f, orderId, {})).toBeUndefined();
    expect(
      await set(
        `UPDATE purchase_orders SET status = 'APPROVED', submitted_at = now(), approved_at = now(),
                current_round = 1 WHERE id = $1`,
      ),
    ).toBeUndefined();
  });

  it('[FR-SM-01] po_app cannot write policy rows or step columns outside its grants', async () => {
    const f = await orderFixture();
    const asApp = (sql: string) =>
      sqlstate(async () => {
        await f.app.query('BEGIN');
        try {
          await f.app.query(`SELECT set_config('app.actor_txid', txid_current()::text, true),
                                    set_config('app.actor_type', 'SYSTEM', true)`);
          await f.app.query(sql);
        } finally {
          await f.app.query('ROLLBACK');
        }
      });
    expect(await asApp(`INSERT INTO approval_policies (version) VALUES (2)`)).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await asApp(`UPDATE approval_policy_tiers SET threshold = 1`)).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await asApp(`DELETE FROM approval_rounds`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await asApp(`UPDATE approval_steps SET tier = 2`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await asApp(`UPDATE approval_rounds SET total = 0`)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('[NFR-PERF-01] the approval indexes exist exactly as planned', async () => {
    const { superuser: q } = await orderFixture();
    const { rows } = await q.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename IN ('approval_rounds', 'approval_steps', 'approval_policy_tiers',
                            'approval_policies')
        ORDER BY indexname`,
    );
    const defs = Object.fromEntries(
      rows.map((r) => [r.indexname, r.indexdef.replace(/^.* USING btree /, '')]),
    );
    expect(defs).toEqual({
      approval_policies_pkey: '(version)',
      approval_policy_tiers_pkey: '(policy_version, tier)',
      approval_rounds_pkey: '(order_id, round)',
      approval_rounds_policy_version_idx: '(policy_version)',
      approval_rounds_submitted_by_idx: '(submitted_by)',
      approval_steps_decided_by_idx: '(decided_by) WHERE (decided_by IS NOT NULL)',
      approval_steps_pkey: '(order_id, round, step)',
    });
  });
});
