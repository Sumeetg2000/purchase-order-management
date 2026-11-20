import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axeViolations } from './support/axe';
import { fakeApi, json, ME } from './support/fake-api';
import { approvedOrder, cancelledOrder, order, ORDER_ID, pendingOrder } from './support/orders';
import { renderApp } from './support/render-app';
import { page } from './support/vendors';

// A cancelled order's page, who may cancel, and the marker on an approved order whose
// owner can't act (contracts/ui.md; spec FR-017, FR-017a, FR-018).

afterEach(() => {
  vi.unstubAllGlobals();
});

const OWNER_ID = order().owner.id;
const APPROVER = { ...ME, id: '0192e4a0-0000-7000-8000-00000000aaaa', roles: ['APPROVER'] };
const USERS = {
  Approver: APPROVER,
  'owner Buyer': { ...ME, id: OWNER_ID, roles: ['BUYER'] },
  'owner Buyer+Approver': { ...ME, id: OWNER_ID, roles: ['BUYER', 'APPROVER'] },
  Admin: { ...ME, id: '0192e4a0-0000-7000-8000-00000000adad', roles: ['ADMIN'] },
} as const;

function show(user: Record<string, unknown>, shown: Record<string, unknown>) {
  fakeApi({
    'GET /me': () => json(200, user),
    [`GET /orders/${ORDER_ID}`]: () => json(200, shown, { ETag: '"3"' }),
    'GET /approvals': () => json(200, page([])),
    'GET /orders': () => json(200, page([])),
  });
  renderApp(`/orders/${ORDER_ID}`);
}

const heading = () => screen.findByRole('heading', { level: 1, name: 'PO-2026-27-000123' });

describe('[FR-LCK-02] who is offered Cancel order', () => {
  it('[FR-SOD-01] only an Approver who does not own an approved order', async () => {
    const offered: Record<string, boolean> = {};
    for (const [who, user] of Object.entries(USERS)) {
      show(user, approvedOrder());
      await heading();
      offered[who] = screen.queryByRole('button', { name: 'Cancel order' }) !== null;
      cleanup();
      vi.unstubAllGlobals();
    }
    expect(offered).toEqual({
      Approver: true,
      'owner Buyer': false,
      'owner Buyer+Approver': false,
      Admin: false,
    });
  });

  it('[FR-SM-01] not on a pending order', async () => {
    show(APPROVER, pendingOrder());
    await heading();
    expect(screen.queryByRole('button', { name: 'Cancel order' })).toBeNull();
  });
});

describe('[NFR-FE-08] a cancelled order', () => {
  it('[FR-LCK-02] shows who cancelled it, when and why, and offers no action', async () => {
    show(USERS['owner Buyer'], cancelledOrder());
    const section = await screen.findByRole('region', { name: 'Cancellation' });
    expect(section).toHaveTextContent(
      'Cancelled by Priya Approver on 19 November 2026 at 11:30 am',
    );
    expect(section).toHaveTextContent('Supplier closed');
    expect(screen.getByText('Cancelled', { exact: true })).toBeInTheDocument();
    const main = screen.getByRole('main');
    for (const name of [
      'Edit',
      'Submit',
      'Withdraw',
      'Delete draft',
      'Approve',
      'Reject',
      'Cancel order',
    ]) {
      expect(within(main).queryByRole('button', { name }), name).toBeNull();
    }
    expect(await axeViolations(document.body)).toEqual([]);
  });
});

describe("[NFR-FE-08] an approved order whose owner can't act", () => {
  const FIRST = "Its owner can no longer act on it, so receipts can't be recorded.";
  const HINT =
    'To close it, cancel it, and a buyer can raise a new order if the goods are still needed.';

  it('[FR-LCK-02] an Approver who may cancel it reads both sentences', async () => {
    show(APPROVER, approvedOrder({ ownerCanAct: false }));
    await heading();
    expect(screen.getByText(FIRST)).toBeInTheDocument();
    expect(screen.getByText(HINT)).toBeInTheDocument();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('[FR-LCK-02] an Admin reads only the first; an owner who can act sees none', async () => {
    show(USERS.Admin, approvedOrder({ ownerCanAct: false }));
    await heading();
    expect(screen.getByText(FIRST)).toBeInTheDocument();
    expect(screen.queryByText(HINT)).toBeNull();
    cleanup();
    vi.unstubAllGlobals();
    show(APPROVER, approvedOrder());
    await heading();
    expect(screen.queryByText(FIRST)).toBeNull();
  });
});
