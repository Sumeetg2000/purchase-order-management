import { screen, waitFor, within } from '@testing-library/react';
import { ORDER_OWNER_INACTIVE_DETAIL } from '@po/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axeViolations } from './support/axe';
import { fakeApi, json, ME, problem, type Handler } from './support/fake-api';
import { ORDER_ID, pendingOrder, pendingRound } from './support/orders';
import { renderApp } from './support/render-app';
import { page } from './support/vendors';

// The Approve dialog (contracts/ui.md, ADR-0018; US3 scenario 7): it names the order,
// buyer, vendor and total, and what approving means; the owner-can't-act marker replaces
// Approve; the nav count refreshes after.

afterEach(() => {
  vi.unstubAllGlobals();
});

const APPROVER = { ...ME, id: '0192e4a0-0000-7000-8000-00000000aaaa', roles: ['APPROVER'] };
const APPROVE = `POST /orders/${ORDER_ID}/approve`;

function approveApi(order: Record<string, unknown>, handlers: Record<string, Handler> = {}) {
  return fakeApi({
    'GET /me': () => json(200, APPROVER),
    [`GET /orders/${ORDER_ID}`]: () => json(200, order, { ETag: '"2"' }),
    'GET /approvals': () => json(200, page([])),
    [APPROVE]: () =>
      json(
        200,
        pendingOrder({
          status: 'APPROVED',
          version: 3,
          approvedAt: '2026-11-17T11:00:00.000Z',
          approval: {
            ...pendingRound(),
            outcome: 'APPROVED',
            closedAt: '2026-11-17T11:00:00.000Z',
            steps: [
              {
                ...pendingRound().steps[0],
                state: 'APPROVED',
                decidedBy: { id: APPROVER.id, name: APPROVER.name },
                decidedAt: '2026-11-17T11:00:00.000Z',
              },
            ],
          },
        }),
        { ETag: '"3"' },
      ),
    ...handlers,
  });
}

async function openDialog() {
  const view = renderApp(`/orders/${ORDER_ID}`);
  await view.user.click(await screen.findByRole('button', { name: 'Approve' }));
  return { ...view, dialog: await screen.findByRole('alertdialog') };
}

describe('[FR-APR-01] the Approve dialog', () => {
  it('[NFR-FE-09] names the order, buyer, vendor and total, and what approving means', async () => {
    approveApi(pendingOrder());
    const { dialog } = await openDialog();
    expect(dialog).toHaveAccessibleName('Approve PO-2026-27-000123?');
    expect(dialog).toHaveTextContent('Bea Buyer');
    expect(dialog).toHaveTextContent('Acme Supplies (as submitted)');
    expect(dialog).toHaveTextContent('₹1,50,000.00');
    expect(dialog).toHaveTextContent(
      "The buyer can then receive goods; the order can't be edited.",
    );
    expect(within(dialog).getByRole('button', { name: 'Not now' })).toHaveFocus();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('[FR-APR-01] approves with If-Match, shows the order approved and refreshes the count', async () => {
    const seen = approveApi(pendingOrder());
    const { user, dialog } = await openDialog();
    const countsBefore = seen.filter((r) => new URL(r.url).pathname.endsWith('/approvals')).length;
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Approved.')).toBeInTheDocument();
    const [request] = seen.filter((r) => r.method === 'POST');
    expect(request?.headers.get('If-Match')).toBe('"2"');
    await waitFor(() => {
      expect(
        seen.filter((r) => new URL(r.url).pathname.endsWith('/approvals')).length,
      ).toBeGreaterThan(countsBefore);
    });
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('[FR-APR-01] an owner who can no longer act: the marker, and no Approve', async () => {
    approveApi(pendingOrder({ ownerCanAct: false }));
    renderApp(`/orders/${ORDER_ID}`);
    expect(await screen.findByText('Owner can no longer act on this order')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('[FR-APR-01] ORDER_OWNER_INACTIVE from the server is said inside the dialog', async () => {
    approveApi(pendingOrder(), {
      [APPROVE]: () => problem(409, 'ORDER_OWNER_INACTIVE'),
    });
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await within(dialog).findByText(ORDER_OWNER_INACTIVE_DETAIL)).toBeInTheDocument();
    // The dialog offers no other decision: Reject stays on the page.
    expect(within(dialog).queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('[FR-APR-01] after ORDER_OWNER_INACTIVE, closing the dialog rereads the order: the marker, and Reject only', async () => {
    let reads = 0;
    approveApi(pendingOrder(), {
      [`GET /orders/${ORDER_ID}`]: () => {
        reads += 1;
        return json(200, pendingOrder({ ownerCanAct: reads === 1 }), { ETag: '"2"' });
      },
      [APPROVE]: () => problem(409, 'ORDER_OWNER_INACTIVE'),
    });
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await within(dialog).findByText(ORDER_OWNER_INACTIVE_DETAIL);
    await user.click(within(dialog).getByRole('button', { name: 'Not now' }));
    expect(await screen.findByText('Owner can no longer act on this order')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    expect(reads).toBeGreaterThan(1);
  });

  it('[FR-SOD-01] the owner, also an Approver, is never offered Approve or Reject, only Withdraw', async () => {
    fakeApi({
      'GET /me': () =>
        json(200, { ...APPROVER, id: pendingOrder().owner.id, roles: ['BUYER', 'APPROVER'] }),
      [`GET /orders/${ORDER_ID}`]: () => json(200, pendingOrder(), { ETag: '"2"' }),
      'GET /approvals': () => json(200, page([])),
    });
    renderApp(`/orders/${ORDER_ID}`);
    await screen.findByText('Acme Supplies (as submitted)');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeInTheDocument();
  });

  it('[FR-SOD-01] even while the owner can no longer act, the owner is offered no decision', async () => {
    fakeApi({
      'GET /me': () =>
        json(200, { ...APPROVER, id: pendingOrder().owner.id, roles: ['BUYER', 'APPROVER'] }),
      [`GET /orders/${ORDER_ID}`]: () =>
        json(200, pendingOrder({ ownerCanAct: false }), { ETag: '"2"' }),
      'GET /approvals': () => json(200, page([])),
    });
    renderApp(`/orders/${ORDER_ID}`);
    await screen.findByText('Acme Supplies (as submitted)');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });
});
