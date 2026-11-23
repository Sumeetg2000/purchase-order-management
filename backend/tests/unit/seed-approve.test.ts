import type { Order } from '@po/contracts';
import { describe, expect, it } from 'vitest';
import type { ApprovalsService } from '../../src/approvals/service.js';
import type { AuthenticatedUser } from '../../src/auth/service.js';
import { approveUntilApproved } from '../../src/migrate/seed-demo.js';

// The demo seed approves a routed order step by step, at most once per policy tier, and
// says plainly when that is not enough.

const pending = { id: 'o1', poNumber: 'PO-2026-27-000001', version: 2, status: 'PENDING_APPROVAL' };
const ctx = () => ({
  requestId: 'r',
  logger: undefined as never,
  ip: '127.0.0.1',
  userAgent: 'test',
});
const approver = { userId: 'a1' } as AuthenticatedUser;

/** An approvals service whose approve moves the order one step: approved after `steps`. */
function stub(steps: number) {
  const calls: number[] = [];
  const approvals = {
    approveOrder: (_who: unknown, target: { version: number }) => {
      calls.push(target.version);
      const done = calls.length >= steps;
      return Promise.resolve({
        ...pending,
        version: target.version + 1,
        status: done ? 'APPROVED' : 'PENDING_APPROVAL',
      });
    },
  } as unknown as ApprovalsService;
  return { approvals, calls };
}

describe('[FR-APR-05] the demo seed approves step by step, bounded by the tiers', () => {
  it('[FR-APR-05] approves once per step until APPROVED, each against the version it saw', async () => {
    const { approvals, calls } = stub(2);
    const order = await approveUntilApproved(approvals, approver, pending as Order, 2, ctx);
    expect(order.status).toBe('APPROVED');
    expect(calls).toEqual([2, 3]);
  });

  it('[FR-APR-05] still pending after one approval per tier: a clear error, no further approval', async () => {
    const { approvals, calls } = stub(3);
    await expect(
      approveUntilApproved(approvals, approver, pending as Order, 2, ctx),
    ).rejects.toThrow(
      'demo order PO-2026-27-000001 is PENDING_APPROVAL after 2 approval(s); the current policy has 2 tier(s)',
    );
    expect(calls).toHaveLength(2);
  });
});
