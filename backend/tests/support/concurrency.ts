import type { ordersHarness } from './orders.js';

// Interleaving helpers for the concurrency suites (slice 4 research R6): barriers on
// PostgreSQL's own lock waits, never sleeps.

export type Harness = Awaited<ReturnType<typeof ordersHarness>>;

/** Waits until some backend of this test's database is waiting on a lock. */
export async function someoneWaits(h: Harness, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const [row] = await h.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if ((row?.n ?? 0) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

/**
 * Holds a user's row FOR UPDATE with a change made but not committed, as an admin
 * deactivation or role change in progress: the approve passes the request's own check
 * (it reads the committed row) and then waits on the row at the end of its lock order.
 */
export async function changeWhileApproving(
  h: Harness,
  userId: string,
  change: string,
  approve: () => Promise<{ status: number; body: unknown }>,
) {
  await h.query('BEGIN');
  await h.query('SET LOCAL session_replication_role = replica');
  await h.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [userId]);
  await h.query(`UPDATE users SET ${change} WHERE id = $1`, [userId]);
  const approving = approve();
  const waited = await someoneWaits(h);
  await h.query('COMMIT');
  return { waited, res: await approving };
}
