import type { Order } from '@po/contracts';
import { describe, expect, it } from 'vitest';
import { changeWhileApproving, type Harness } from '../support/concurrency.js';
import { lineBody, ordersHarness } from '../support/orders.js';

// Submissions under concurrent requests (research R6, FR-017, SC-005). Business outcomes:
// the final status is the routing of the final total; a submit and a vendor deactivation
// or a policy change each end in a state consistent with one order of the two.

describe('[NFR-CON-01] concurrent submissions', () => {
  it('[NFR-CON-01] an edit racing a submit: one wins, the other is 409, and the status routes the final total', async () => {
    const h = await ordersHarness();
    for (let run = 0; run < 5; run += 1) {
      const draft = await h.draftAt('50000');
      // The edit takes the total above the threshold.
      const [edit, submit] = await Promise.all([
        h.editOrder(
          draft.id,
          h.orderBody([lineBody({ id: draft.lines[0]?.id, quantity: 3, unitPrice: '50000' })]),
          1,
        ),
        h.submitOrder(draft.id, 1),
      ]);
      expect([edit.status, submit.status].sort()).toEqual([200, 409]);
      const order = (await h.getOrder(draft.id)).body as Order;
      if (edit.status === 200) {
        expect(order).toMatchObject({ status: 'DRAFT', total: '150000.0000' });
      } else {
        expect(order).toMatchObject({ status: 'APPROVED', total: '50000.0000' });
      }
    }
  });

  it('[NFR-CON-01] a submit racing a vendor deactivation: submitted before it, or VENDOR_INACTIVE after', async () => {
    const h = await ordersHarness();
    const draft = await h.draftAt('150000');
    const vendor = (await h.get(`/vendors/${h.vendorId}`, h.jar)).body as { version: number };
    const [submit, deactivate] = await Promise.all([
      h.submitOrder(draft.id, 1),
      h.send('post', `/vendors/${h.vendorId}/deactivate`, h.jar, undefined, {
        'If-Match': `"${String(vendor.version)}"`,
      }),
    ]);
    expect(deactivate.status).toBe(200);
    const order = (await h.getOrder(draft.id)).body as Order;
    if (submit.status === 200) {
      expect(order.status).toBe('PENDING_APPROVAL');
    } else {
      expect(submit.body).toMatchObject({ code: 'VENDOR_INACTIVE' });
      expect(order.status).toBe('DRAFT');
    }
  });

  it('[NFR-CON-01] a submit racing a policy change routes by the version it recorded', async () => {
    const h = await ordersHarness();
    const draft = await h.draftAt('150000');
    const setPolicy = async () => {
      await h.query('BEGIN');
      await h.query(`SELECT set_config('app.actor_txid', txid_current()::text, true),
                            set_config('app.actor_type', 'OPERATOR', true),
                            set_config('app.os_user', 'tester', true),
                            set_config('app.os_host', 'ci', true)`);
      await h.query(`SELECT set_approval_policy('{200000}')`);
      await h.query('COMMIT');
    };
    const [submit] = await Promise.all([h.submitOrder(draft.id, 1), setPolicy()]);
    const order = submit.body as Order;
    expect(submit.status).toBe(200);
    // Version 1 needs one step for ₹1,50,000; version 2 none.
    expect(
      order.approval?.policyVersion === 1
        ? order.status === 'PENDING_APPROVAL'
        : order.status === 'APPROVED',
    ).toBe(true);
  });
});

describe('[NFR-CON-01] a submit and a policy change, deterministically interleaved', () => {
  it('[NFR-CON-01] a submit waits for a policy change in progress, then routes by the new version', async () => {
    const h = await ordersHarness();
    const draft = await h.draftAt('150000');
    // A policy change holds its lock until it commits.
    await h.query('BEGIN');
    await h.query(`SELECT set_config('app.actor_txid', txid_current()::text, true),
                          set_config('app.actor_type', 'OPERATOR', true),
                          set_config('app.os_user', 'tester', true),
                          set_config('app.os_host', 'ci', true)`);
    await h.query(`SELECT set_approval_policy('{200000}')`);
    // supertest sends on then(): start it now, while the policy change is open.
    const submitting = h.submitOrder(draft.id, 1).then((r) => r);
    // Long enough for the submit to reach the policy read and wait there.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await h.query('COMMIT');
    const res = await submitting;
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'APPROVED', approval: { policyVersion: 2 } });
  });
});

async function pendingFor(h: Harness) {
  const draft = await h.draftAt('200000');
  await h.submitOrder(draft.id, 1);
  return draft.id;
}

describe('[NFR-CON-01] approve under concurrent changes to the people involved', () => {
  it('[FR-APR-01] the owner deactivated, or stripped of BUYER, while an approve waits: ORDER_OWNER_INACTIVE, never approved after', async () => {
    const h = await ordersHarness();
    const priya = await h.approver();
    for (const change of [
      `status = 'DEACTIVATED', deactivated_at = now()`,
      `roles = '{APPROVER}'`,
    ]) {
      const id = await pendingFor(h);
      const { waited, res } = await changeWhileApproving(h, h.buyer.id, change, () =>
        h.approveOrder(id, 2, priya.jar).then((r) => r),
      );
      expect(waited, change).toBe(true);
      expect(res.body, change).toMatchObject({ code: 'ORDER_OWNER_INACTIVE' });
      expect(((await h.getOrder(id, priya.jar)).body as Order).status).toBe('PENDING_APPROVAL');
      await h.setUser(h.buyer.id, { status: 'ACTIVE', roles: '{BUYER}' });
    }
  });

  it('[FR-SOD-01] the acting Approver deactivated, or stripped of APPROVER, while their approve waits: 401 / 403, never decided after', async () => {
    const h = await ordersHarness();
    for (const [change, code] of [
      [`status = 'DEACTIVATED', deactivated_at = now()`, 'ACCOUNT_DEACTIVATED'],
      [`roles = '{BUYER}'`, 'FORBIDDEN'],
    ] as const) {
      const priya = await h.approver();
      const id = await pendingFor(h);
      const { waited, res } = await changeWhileApproving(h, priya.id, change, () =>
        h.approveOrder(id, 2, priya.jar).then((r) => r),
      );
      expect(waited, change).toBe(true);
      expect(res.body, change).toMatchObject({ code });
      const [step] = await h.query<{ state: string }>(
        `SELECT state FROM approval_steps WHERE order_id = $1`,
        [id],
      );
      expect(step?.state, change).toBe('OPEN');
    }
  });

  it('[NFR-CON-01] two approves of one step (two tabs): exactly one decision', async () => {
    const h = await ordersHarness();
    const priya = await h.approver();
    const id = await pendingFor(h);
    const results = await Promise.all([
      h.approveOrder(id, 2, priya.jar),
      h.approveOrder(id, 2, priya.jar),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const [row] = await h.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_entries
        WHERE order_id = $1 AND action = 'APPROVAL_STEP_APPROVED'`,
      [id],
    );
    expect(row?.n).toBe(1);
  });

  it('[NFR-CON-01] an approve racing a vendor deactivation: approved before it, or VENDOR_INACTIVE after', async () => {
    const h = await ordersHarness();
    const priya = await h.approver();
    const id = await pendingFor(h);
    const vendor = (await h.get(`/vendors/${h.vendorId}`, h.jar)).body as { version: number };
    const [approve, deactivate] = await Promise.all([
      h.approveOrder(id, 2, priya.jar),
      h.send('post', `/vendors/${h.vendorId}/deactivate`, h.jar, undefined, {
        'If-Match': `"${String(vendor.version)}"`,
      }),
    ]);
    expect(deactivate.status).toBe(200);
    if (approve.status === 200) expect(approve.body).toMatchObject({ status: 'APPROVED' });
    else expect(approve.body).toMatchObject({ code: 'VENDOR_INACTIVE' });
  });

  it('[NFR-CON-01] approves and admin changes of the owner and of the Approver, started together, never deadlock', async () => {
    const h = await ordersHarness();
    const admin = await h.loggedIn(await h.seedUser({ roles: '{ADMIN}' }));
    for (let run = 0; run < 4; run += 1) {
      // Fresh people each run: a role change ends the changed user's sessions.
      const owner = await h.approver('{BUYER}', 'Run Buyer');
      const priya = await h.approver();
      const draft = await h.draftAt('200000', owner.jar);
      await h.submitOrder(draft.id, 1, owner.jar);
      // Alternate whom the admin changes, and which request starts first.
      const target = run % 2 === 0 ? owner.id : priya.id;
      const adminChange = () =>
        h.send(
          'patch',
          `/admin/users/${target}`,
          admin,
          { roles: ['BUYER', 'APPROVER'] },
          { 'If-Match': '"1"' },
        );
      const approve = () => h.approveOrder(draft.id, 2, priya.jar);
      const [approved, changed] =
        run < 2
          ? await Promise.all([approve(), adminChange()])
          : (await Promise.all([adminChange(), approve()])).reverse();
      // Neither waits forever or fails. The change keeps both able to act, but a role
      // change ends the changed user's sessions (ADR-0017): an Approver changed first may
      // find their session revoked.
      expect(changed?.status, JSON.stringify(changed?.body)).toBe(200);
      if (target === priya.id && approved?.status === 401) {
        expect(approved.body).toMatchObject({ code: 'SESSION_REVOKED' });
      } else {
        expect(approved?.status, JSON.stringify(approved?.body)).toBe(200);
        expect(approved?.body).toMatchObject({ status: 'APPROVED' });
      }
    }
  });
});

describe('[NFR-CON-01] decisions and withdrawals racing each other', () => {
  const reason = { reason: 'Racing' };

  it('[FR-SM-03] approve vs reject on one step: one decision, and the status is its outcome', async () => {
    const h = await ordersHarness();
    const priya = await h.approver();
    const ravi = await h.approver('{APPROVER}', 'Ravi Approver');
    for (let run = 0; run < 3; run += 1) {
      const id = await pendingFor(h);
      const [approve, reject] = await Promise.all([
        h.approveOrder(id, 2, priya.jar),
        h.rejectOrder(id, 2, ravi.jar, reason),
      ]);
      expect([approve.status, reject.status].sort()).toEqual([200, 409]);
      const order = (await h.getOrder(id)).body as Order;
      expect(order.status).toBe(approve.status === 200 ? 'APPROVED' : 'REJECTED');
      const [row] = await h.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM approval_steps
          WHERE order_id = $1 AND state IN ('APPROVED', 'REJECTED')`,
        [id],
      );
      expect(row?.n).toBe(1);
    }
  });

  it('[FR-SM-03] approve vs withdraw: APPROVED with nothing voided, or DRAFT with every step voided and no approval', async () => {
    const h = await ordersHarness();
    const priya = await h.approver();
    for (let run = 0; run < 3; run += 1) {
      const id = await pendingFor(h);
      const [approve, withdraw] = await Promise.all([
        h.approveOrder(id, 2, priya.jar),
        h.withdrawOrder(id, 2, h.jar, reason),
      ]);
      // A withdraw that wins makes the order a draft, unreadable to the Approver: 404 (S7).
      if (withdraw.status === 200) expect(approve.status).toBe(404);
      else expect([approve.status, withdraw.status]).toEqual([200, 409]);
      const states = await h.query<{ state: string; decided: boolean }>(
        `SELECT state, decided_by IS NOT NULL AS decided FROM approval_steps WHERE order_id = $1`,
        [id],
      );
      const order = (await h.getOrder(id)).body as Order;
      if (approve.status === 200) {
        expect(order.status).toBe('APPROVED');
        expect(states).toEqual([{ state: 'APPROVED', decided: true }]);
      } else {
        expect(order.status).toBe('DRAFT');
        expect(states).toEqual([{ state: 'VOIDED', decided: false }]);
      }
    }
  });

  it('[FR-SM-03] withdraw vs reject: DRAFT or REJECTED, never both', async () => {
    const h = await ordersHarness();
    const priya = await h.approver();
    for (let run = 0; run < 3; run += 1) {
      const id = await pendingFor(h);
      const [withdraw, reject] = await Promise.all([
        h.withdrawOrder(id, 2, h.jar, reason),
        h.rejectOrder(id, 2, priya.jar, reason),
      ]);
      // A withdraw that wins makes the order a draft, unreadable to the Approver: 404 (S7).
      if (withdraw.status === 200) expect(reject.status).toBe(404);
      else expect([withdraw.status, reject.status]).toEqual([409, 200]);
      const order = (await h.getOrder(id)).body as Order;
      expect(order.status).toBe(withdraw.status === 200 ? 'DRAFT' : 'REJECTED');
    }
  });

  it('[FR-SOD-01] a reject while the acting Approver is deactivated: 401, never decided after', async () => {
    const h = await ordersHarness();
    const priya = await h.approver();
    const id = await pendingFor(h);
    const { waited, res } = await changeWhileApproving(
      h,
      priya.id,
      `status = 'DEACTIVATED', deactivated_at = now()`,
      () => h.rejectOrder(id, 2, priya.jar, reason).then((r) => r),
    );
    expect(waited).toBe(true);
    expect(res.body).toMatchObject({ code: 'ACCOUNT_DEACTIVATED' });
    expect(((await h.getOrder(id)).body as Order).status).toBe('PENDING_APPROVAL');
  });
});
