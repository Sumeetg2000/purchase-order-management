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
