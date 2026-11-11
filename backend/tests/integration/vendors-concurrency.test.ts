import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { vendorBody, vendorsHarness } from '../support/vendors.js';

// Concurrent vendor writes behind a barrier (research R3, SC-002): PostgreSQL's unique
// name key decides, and the loser is answered with the winner, never a 500.

/** Waits until `count` backends are queued for a lock on the vendors table. */
async function waitForWaiters(client: pg.Client, count: number): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    const { rows } = await client.query<{ waiting: string }>(
      `SELECT count(*) AS waiting FROM pg_locks
        WHERE relation = 'vendors'::regclass AND NOT granted`,
    );
    if (Number(rows[0]?.waiting) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fewer than ${String(count)} writers reached the vendors table`);
}

describe('[FR-VEN-01] concurrent vendor creates', () => {
  it('[FR-VEN-01] two creates of one normalised name: one 201, one 409 naming the winner', async () => {
    const h = await vendorsHarness();
    const other = await h.loggedIn(await h.seedUser({ roles: '{BUYER}' }));

    // The barrier: an exclusive table lock lets both requests run up to their INSERT and
    // queue there; releasing it lets both inserts race for the same name key.
    const barrier = await h.db.client('postgres');
    await barrier.query('BEGIN');
    await barrier.query('LOCK TABLE vendors IN EXCLUSIVE MODE');
    const racing = Promise.all([
      h.createVendor(vendorBody({ name: 'Acme Supplies' })),
      h.createVendor(vendorBody({ name: 'ACME  supplies' }), other),
    ]);
    await waitForWaiters(barrier, 2);
    await barrier.query('COMMIT');
    const results = await racing;

    const statuses = results.map((res) => res.status).sort();
    expect(statuses).toEqual([201, 409]);
    const winner = results.find((res) => res.status === 201);
    const loser = results.find((res) => res.status === 409);
    const won = winner?.body as { id: string; name: string };
    expect(loser?.body).toMatchObject({
      code: 'DUPLICATE_VENDOR_NAME',
      existingVendor: { id: won.id, name: won.name },
    });
    expect(await h.query('SELECT id FROM vendors')).toHaveLength(1);
    expect(await h.vendorAudit()).toHaveLength(1);
  });
});

/** Waits until `count` backends wait on another transaction (a row or a unique key). */
async function waitForTransactionWaiters(client: pg.Client, count: number): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    const { rows } = await client.query<{ waiting: string }>(
      `SELECT count(*) AS waiting FROM pg_locks
        WHERE locktype = 'transactionid' AND NOT granted`,
    );
    if (Number(rows[0]?.waiting) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fewer than ${String(count)} writers waited on the barrier`);
}

describe('[FR-VEN-01] concurrent vendor edits', () => {
  it('[FR-VEN-01] two edits with the same version: one 200, one 409 VERSION_CONFLICT', async () => {
    const h = await vendorsHarness();
    const other = await h.loggedIn(await h.seedUser({ roles: '{BUYER}' }));
    const id = await h.seedVendor({ name: 'Acme Supplies' });

    // Both requests queue at their FOR UPDATE behind the table lock, then race for the row.
    const barrier = await h.db.client('postgres');
    await barrier.query('BEGIN');
    await barrier.query('LOCK TABLE vendors IN EXCLUSIVE MODE');
    const racing = Promise.all([
      h.updateVendor(id, vendorBody({ contactName: 'First' }), 1),
      h.updateVendor(id, vendorBody({ contactName: 'Second' }), 1, other),
    ]);
    await waitForWaiters(barrier, 2);
    await barrier.query('COMMIT');
    const results = await racing;

    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(results.find((res) => res.status === 409)?.body).toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    expect(await h.query('SELECT version FROM vendors WHERE id = $1', [id])).toEqual([
      { version: 2 },
    ]);
    expect(await h.vendorAudit()).toHaveLength(1);
  });

  it('[FR-VEN-01] two renames to one new name: one 200, one 409 naming the winner', async () => {
    const h = await vendorsHarness();
    const other = await h.loggedIn(await h.seedUser({ roles: '{BUYER}' }));
    const first = await h.seedVendor({ name: 'Acme Supplies' });
    const second = await h.seedVendor({ name: 'Bolt Traders' });

    // The barrier holds the new name's key uncommitted: both edits pass their clash check
    // (it can't see the barrier's row), then wait on the key at UPDATE. Rolling it back
    // lets one rename take the key; the other hits the unique constraint (research R3).
    const barrier = await h.db.client('postgres');
    await barrier.query('BEGIN');
    await barrier.query('SET LOCAL session_replication_role = replica');
    await barrier.query(
      `INSERT INTO vendors (name, contact_name, contact_email, payment_term_type, net_days)
       VALUES ('Zenith Metals', 'X', 'x@x.example', 'NET', 30)`,
    );
    const racing = Promise.all([
      h.updateVendor(first, vendorBody({ name: 'Zenith Metals' }), 1),
      h.updateVendor(second, vendorBody({ name: 'ZENITH  metals' }), 1, other),
    ]);
    await waitForTransactionWaiters(barrier, 2);
    await barrier.query('ROLLBACK');
    const results = await racing;

    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    const won = results.find((res) => res.status === 200)?.body as { id: string; name: string };
    expect(results.find((res) => res.status === 409)?.body).toMatchObject({
      code: 'DUPLICATE_VENDOR_NAME',
      existingVendor: { id: won.id, name: won.name },
    });
    expect(await h.vendorAudit()).toHaveLength(1);
  });
});
