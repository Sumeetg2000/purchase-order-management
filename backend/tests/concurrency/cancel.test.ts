import type { Order } from '@po/contracts';
import { describe, expect, it } from 'vitest';
import { changeWhileApproving, type Harness } from '../support/concurrency.js';
import { ordersHarness } from '../support/orders.js';

// Cancels under concurrent requests (US5, research R4, SC-003). Business outcomes: at most
// one cancel is recorded, a cancel never commits after the canceller lost the right to
// make it, and nothing deadlocks.

const reason = { reason: 'Supplier closed' };

/** An approved order (auto-approved on submit), at version 2. */
async function approvedFor(h: Harness) {
  const draft = await h.draftAt('10');
  await h.submitOrder(draft.id, 1);
  return draft.id;
}

async function cancels(h: Harness, id: string) {
  const rows = await h.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_entries WHERE action = 'PO_CANCELLED' AND order_id = $1`,
    [id],
  );
  return rows[0]?.n ?? 0;
}

describe('[NFR-CON-01] cancel under concurrent changes to the canceller', () => {
  it('[FR-SOD-01] the Approver deactivated, or stripped of APPROVER, while their cancel waits: 401 / 403, never cancelled after', async () => {
    const h = await ordersHarness();
    for (const [change, code] of [
      [`status = 'DEACTIVATED', deactivated_at = now()`, 'ACCOUNT_DEACTIVATED'],
      [`roles = '{BUYER}'`, 'FORBIDDEN'],
    ] as const) {
      const priya = await h.approver();
      const id = await approvedFor(h);
      const { waited, res } = await changeWhileApproving(h, priya.id, change, () =>
        h.cancelOrder(id, 2, priya.jar, reason).then((r) => r),
      );
      expect(waited, change).toBe(true);
      expect(res.body, change).toMatchObject({ code });
      expect(((await h.getOrder(id)).body as Order).status, change).toBe('APPROVED');
      expect(await cancels(h, id), change).toBe(0);
    }
  });
});
