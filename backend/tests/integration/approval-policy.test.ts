import { OPERATIONS, type ApprovalPolicy } from '@po/contracts';
import { describe, expect, it } from 'vitest';
import { ordersHarness } from '../support/orders.js';

// The current policy is readable by every role (FR-016, ADR-0002); nothing over HTTP
// writes it.

describe('[FR-APR-04] read the approval policy', () => {
  it('[FR-APR-04] Buyer, Approver and Admin read version 1 with its one tier; no role is refused', async () => {
    const h = await ordersHarness();
    for (const roles of ['{BUYER}', '{APPROVER}', '{ADMIN}', '{BUYER,APPROVER}']) {
      const jar = await h.loggedIn(await h.seedUser({ roles }));
      const res = await h.get('/approval-policy', jar);
      expect(res.status, roles).toBe(200);
      const policy = res.body as ApprovalPolicy;
      expect(policy, roles).toMatchObject({
        version: 1,
        tiers: [{ tier: 1, threshold: '100000.0000' }],
      });
    }
    const none = await h.loggedIn(await h.seedUser({ roles: '{}' }));
    expect((await h.get('/approval-policy', none)).body).toMatchObject({
      code: 'NO_ROLE_ASSIGNED',
    });
  });

  it('[FR-APR-04] the latest version is the current one', async () => {
    const h = await ordersHarness();
    await h.addPolicy(2, ['200000']);
    expect((await h.get('/approval-policy', h.jar)).body).toMatchObject({
      version: 2,
      tiers: [{ tier: 1, threshold: '200000.0000' }],
    });
  });

  it('[FR-APR-05] no HTTP operation writes the policy', () => {
    const writes = Object.values(OPERATIONS).filter(
      (op) => op.path.includes('approval-polic') && op.method !== 'get',
    );
    expect(writes).toEqual([]);
  });
});
