import {
  ORDER_ADMIN_READ_ONLY_MESSAGE,
  ORDER_APPROVER_READ_ONLY_MESSAGE,
  NOT_ORDER_OWNER_DETAIL,
  type Order,
} from '@po/contracts';
import { describe, expect, it } from 'vitest';
import { ordersHarness } from '../support/orders.js';
import { plantSubmitted } from '../support/orders-sql.js';

// Submit through the API (US1, FR-001, FR-004, FR-017, FR-018): If-Match, no body, the
// vendor active and snapshotted, a specific code for every refusal, ADR-0004's cells.

describe('[FR-APR-01] submit a draft', () => {
  it('[FR-APR-01] a pending submit returns the order with its submission, snapshot and round', async () => {
    const h = await ordersHarness();
    const draft = await h.draftAt('150000');
    const res = await h.submitOrder(draft.id, 1);
    expect(res.status).toBe(200);
    expect(res.headers['etag']).toBe('"2"');
    const order = res.body as Order;
    expect(order).toMatchObject({
      status: 'PENDING_APPROVAL',
      version: 2,
      approvedAt: null,
      ownerCanAct: true,
      vendorSnapshot: {
        id: h.vendorId,
        name: 'Acme Supplies',
        paymentTerms: { type: 'NET', netDays: 30 },
      },
      approval: {
        round: 1,
        policyVersion: 1,
        outcome: null,
        closedAt: null,
        withdrawReason: null,
        steps: [
          {
            step: 1,
            tier: 1,
            threshold: '100000.0000',
            state: 'OPEN',
            decidedBy: null,
            decidedAt: null,
            reason: null,
          },
        ],
      },
    });
    expect(order.submittedAt).toBe(order.approval?.submittedAt);
  });

  it('[FR-APR-01] an auto-approved submit has its approval time and a closed round', async () => {
    const h = await ordersHarness();
    const draft = await h.draftAt('99.5');
    const order = (await h.submitOrder(draft.id, 1)).body as Order;
    expect(order.status).toBe('APPROVED');
    expect(order.approvedAt).toBe(order.approval?.closedAt);
    expect(order.approval?.outcome).toBe('AUTO_APPROVED');
  });

  it('[FR-VEN-03] the snapshot stays as submitted after the vendor is edited', async () => {
    const h = await ordersHarness();
    const draft = await h.draftAt('150000');
    await h.submitOrder(draft.id, 1);
    // A later vendor edit, below the guards (the vendor API is slice 2's).
    await h.query('BEGIN');
    await h.query('SET LOCAL session_replication_role = replica');
    await h.query(`UPDATE vendors SET name = 'Acme Renamed' WHERE id = $1`, [h.vendorId]);
    await h.query('COMMIT');
    const order = (await h.getOrder(draft.id)).body as Order;
    expect(order.vendorSnapshot?.name).toBe('Acme Supplies');
  });

  it('[FR-VEN-03] an inactive vendor is 409 VENDOR_INACTIVE and nothing changes', async () => {
    const h = await ordersHarness();
    const draft = await h.draftAt('150000');
    await h.query('BEGIN');
    await h.query('SET LOCAL session_replication_role = replica');
    await h.query(`UPDATE vendors SET status = 'INACTIVE', deactivated_at = now() WHERE id = $1`, [
      h.vendorId,
    ]);
    await h.query('COMMIT');
    const res = await h.submitOrder(draft.id, 1);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'VENDOR_INACTIVE' });
    expect(((await h.getOrder(draft.id)).body as Order).status).toBe('DRAFT');
  });

  it('[NFR-CON-03] If-Match is required and must be current', async () => {
    const h = await ordersHarness();
    const draft = await h.draftAt('10');
    const missing = await h.submitOrder(draft.id, null);
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ code: 'VERSION_REQUIRED' }],
    });
    expect((await h.submitOrder(draft.id, 7)).body).toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('[NFR-VAL-01] submit takes no input: an empty object passes, any field is refused', async () => {
    const h = await ordersHarness();
    const a = await h.draftAt('10');
    const b = await h.draftAt('10');
    expect((await h.submitOrder(a.id, 1, h.jar, {})).status).toBe(200);
    const res = await h.submitOrder(b.id, 1, h.jar, { status: 'APPROVED' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ details: [{ path: 'body.status', code: 'UNKNOWN_FIELD' }] });
  });

  it('[FR-SM-01] a second submit is 409 INVALID_STATE_TRANSITION naming the status and SUBMIT', async () => {
    const h = await ordersHarness();
    const draft = await h.draftAt('150000');
    await h.submitOrder(draft.id, 1);
    const res = await h.submitOrder(draft.id, 2);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
      orderState: { status: 'PENDING_APPROVAL', action: 'SUBMIT' },
    });
  });
});

describe('[FR-OWN-01] who may submit', () => {
  it("[FR-OWN-01] another Buyer gets 404; a Buyer+Approver on another's submitted order NOT_ORDER_OWNER", async () => {
    const h = await ordersHarness();
    const draft = await h.draftAt('150000');
    const other = await h.loggedIn(await h.seedUser({ roles: '{BUYER}' }));
    expect((await h.submitOrder(draft.id, 1, other)).status).toBe(404);
    await plantSubmitted(h, draft.id, 'PENDING_APPROVAL');
    const both = await h.loggedIn(await h.seedUser({ roles: '{BUYER,APPROVER}' }));
    const res = await h.submitOrder(draft.id, 2, both);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'NOT_ORDER_OWNER', detail: NOT_ORDER_OWNER_DETAIL });
  });

  it('[FR-ACT-01] an Admin and a pure Approver are refused at the route, each told why', async () => {
    const h = await ordersHarness();
    const draft = await h.draftAt('10');
    for (const [roles, detail] of [
      ['{ADMIN}', ORDER_ADMIN_READ_ONLY_MESSAGE],
      ['{APPROVER}', ORDER_APPROVER_READ_ONLY_MESSAGE],
    ] as const) {
      const jar = await h.loggedIn(await h.seedUser({ roles }));
      const res = await h.submitOrder(draft.id, null, jar, { bogus: 1 });
      expect(res.status, roles).toBe(403);
      expect(res.body, roles).toMatchObject({ code: 'FORBIDDEN', detail });
    }
  });
});
