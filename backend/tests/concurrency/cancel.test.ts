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

/** SC-003: each race is repeated, the request order alternating. */
const RUNS = 10;

describe('[NFR-CON-01] cancels racing each other and the people and vendor involved', () => {
  it('[NFR-CON-01] two cancels of one order (two Approvers): exactly one cancel recorded', async () => {
    const h = await ordersHarness();
    const priya = await h.approver();
    const ravi = await h.approver('{APPROVER}', 'Ravi Approver');
    for (let run = 0; run < RUNS; run += 1) {
      const id = await approvedFor(h);
      const [first, second] = await Promise.all([
        h.cancelOrder(id, 2, (run % 2 === 0 ? priya : ravi).jar, reason),
        h.cancelOrder(id, 2, (run % 2 === 0 ? ravi : priya).jar, reason),
      ]);
      const loser = first.status === 200 ? second : first;
      expect([first.status, second.status].sort(), `run ${String(run)}`).toEqual([200, 409]);
      expect(['VERSION_CONFLICT', 'INVALID_STATE_TRANSITION']).toContain(
        (loser.body as { code: string }).code,
      );
      expect(((await h.getOrder(id)).body as Order).status).toBe('CANCELLED');
      expect(await cancels(h, id)).toBe(1);
    }
  });

  it("[FR-SOD-01] a cancel and an admin's deactivation or APPROVER removal of the canceller, started together: one outcome, no deadlock", async () => {
    const h = await ordersHarness();
    const admin = await h.loggedIn(await h.seedUser({ roles: '{ADMIN}' }));
    for (let run = 0; run < RUNS; run += 1) {
      // Fresh Approver each run: the change ends their sessions (ADR-0017).
      const priya = await h.approver();
      const id = await approvedFor(h);
      const body = run % 4 < 2 ? { isActive: false } : { roles: ['BUYER'] };
      const change = () =>
        h.send('patch', `/admin/users/${priya.id}`, admin, body, { 'If-Match': '"1"' });
      const cancel = () => h.cancelOrder(id, 2, priya.jar, reason);
      const [cancelled, changed] =
        run % 2 === 0
          ? await Promise.all([cancel(), change()])
          : (await Promise.all([change(), cancel()])).reverse();
      const label = `run ${String(run)} ${JSON.stringify(body)}`;
      expect(changed?.status, label).toBe(200);
      const status = ((await h.getOrder(id)).body as Order).status;
      if (cancelled?.status === 200) {
        expect(status, label).toBe('CANCELLED');
        expect(await cancels(h, id), label).toBe(1);
      } else {
        expect([401, 403], label).toContain(cancelled?.status);
        expect(status, label).toBe('APPROVED');
        expect(await cancels(h, id), label).toBe(0);
      }
    }
  });

  it('[FR-VEN-02] a cancel racing its vendor deactivation: both succeed, no deadlock', async () => {
    const h = await ordersHarness();
    const priya = await h.approver();
    for (let run = 0; run < RUNS; run += 1) {
      const vendorId = await h.seedVendor({ name: `Racing Vendor ${String(run)}` });
      const created = await h.createOrder(
        h.orderBody([{ description: 'Bolts', quantity: 1, unitPrice: '10' }], { vendorId }),
      );
      const id = (created.body as { id: string }).id;
      await h.submitOrder(id, 1);
      const deactivate = () =>
        h.send('post', `/vendors/${vendorId}/deactivate`, h.jar, undefined, { 'If-Match': '"1"' });
      const cancel = () => h.cancelOrder(id, 2, priya.jar, reason);
      const [cancelled, deactivated] =
        run % 2 === 0
          ? await Promise.all([cancel(), deactivate()])
          : (await Promise.all([deactivate(), cancel()])).reverse();
      expect(deactivated?.status, `run ${String(run)}`).toBe(200);
      expect(cancelled?.status, `run ${String(run)}`).toBe(200);
      expect(cancelled?.body).toMatchObject({ status: 'CANCELLED' });
    }
  });

  it("[FR-ACT-01] a cancel racing the owner's deactivation or BUYER removal: both succeed, no deadlock", async () => {
    const h = await ordersHarness();
    const admin = await h.loggedIn(await h.seedUser({ roles: '{ADMIN}' }));
    const priya = await h.approver();
    for (let run = 0; run < RUNS; run += 1) {
      const owner = await h.approver('{BUYER}', 'Run Buyer');
      const draft = await h.draftAt('10', owner.jar);
      await h.submitOrder(draft.id, 1, owner.jar);
      const body = run % 4 < 2 ? { isActive: false } : { roles: ['APPROVER'] };
      const change = () =>
        h.send('patch', `/admin/users/${owner.id}`, admin, body, { 'If-Match': '"1"' });
      const cancel = () => h.cancelOrder(draft.id, 2, priya.jar, reason);
      const [cancelled, changed] =
        run % 2 === 0
          ? await Promise.all([cancel(), change()])
          : (await Promise.all([change(), cancel()])).reverse();
      const label = `run ${String(run)} ${JSON.stringify(body)}`;
      expect(changed?.status, label).toBe(200);
      expect(cancelled?.status, label).toBe(200);
      expect(cancelled?.body, label).toMatchObject({ status: 'CANCELLED' });
    }
  });

  it("[FR-LCK-01] a cancel racing the owner's edit or delete: the cancel wins, the edit or delete is ORDER_LOCKED", async () => {
    const h = await ordersHarness();
    const priya = await h.approver();
    for (let run = 0; run < RUNS; run += 1) {
      const id = await approvedFor(h);
      const lineId = ((await h.getOrder(id)).body as Order).lines[0]?.id;
      const write =
        run % 2 === 0
          ? () =>
              h.editOrder(
                id,
                h.orderBody([{ id: lineId, description: 'x', quantity: 2, unitPrice: '10' }]),
                2,
              )
          : () => h.deleteOrder(id, 2);
      const [cancelled, written] = await Promise.all([
        h.cancelOrder(id, 2, priya.jar, reason),
        write(),
      ]);
      expect(cancelled.status, `run ${String(run)}`).toBe(200);
      expect(written.status, `run ${String(run)}`).toBe(409);
      const body = written.body as { code: string; orderState: { status: string } };
      expect(body.code).toBe('ORDER_LOCKED');
      expect(['APPROVED', 'CANCELLED']).toContain(body.orderState.status);
      expect(await cancels(h, id)).toBe(1);
    }
  });
});
