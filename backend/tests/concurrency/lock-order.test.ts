import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ordersHarness } from '../support/orders.js';

// ADR-0006 (amended 2026-11-17): order commands take users rows only last, and no code
// path locks a users row and then an order, line, round, step or vendor. With users last on
// one side and absent on the other, no lock cycle can form between the two families.

const SRC = new URL('../../src/', import.meta.url).pathname;

describe('[NFR-CON-01] lock order between order commands and user management', () => {
  it('[NFR-CON-01] an approve waiting on a users row already holds the order, its steps and the vendor', async () => {
    const h = await ordersHarness();
    const priya = await h.approver();
    const draft = await h.draftAt('200000');
    await h.submitOrder(draft.id, 1);
    // Hold the owner's row, as an admin change in progress would.
    await h.query('BEGIN');
    await h.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [h.buyer.id]);
    const approving = h.approveOrder(draft.id, 2, priya.jar).then((r) => r);
    let held: string[] = [];
    let waitingOn: string[] = [];
    for (let i = 0; i < 250 && waitingOn.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const rows = await h.query<{ relname: string | null; locktype: string; granted: boolean }>(
        `SELECT c.relname, l.locktype, l.granted
           FROM pg_locks l
           JOIN pg_stat_activity a ON a.pid = l.pid
           LEFT JOIN pg_class c ON c.oid = l.relation
          WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()
            AND a.wait_event_type = 'Lock'`,
      );
      waitingOn = rows.filter((r) => !r.granted).map((r) => r.locktype);
      held = rows.filter((r) => r.granted && r.relname !== null).map((r) => r.relname ?? '');
    }
    await h.query('COMMIT');
    expect((await approving).status).toBe(200);
    // It waits for the row holder's transaction, on a users row (its tuple lock).
    expect(waitingOn).toContain('transactionid');
    expect(held).toEqual(
      expect.arrayContaining(['purchase_orders', 'approval_steps', 'vendors', 'users']),
    );
  });

  it('[NFR-CON-01] user-management code never touches order data', async () => {
    const areas = [
      'auth',
      'users',
      'admin-users',
      'accounts',
      'tokens',
      'profile',
      'access-requests',
    ];
    const orderTables = /\b(purchase_orders|order_lines|approval_rounds|approval_steps|vendors)\b/;
    const offenders: string[] = [];
    for (const area of areas) {
      for (const file of await readdir(join(SRC, area))) {
        if (!file.endsWith('.ts')) continue;
        const text = await readFile(join(SRC, area, file), 'utf8');
        if (orderTables.test(text)) offenders.push(`${area}/${file}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
