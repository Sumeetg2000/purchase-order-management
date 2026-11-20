import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axeViolations } from './support/axe';
import { fakeApi, json, ME } from './support/fake-api';
import { ORDER_ID, queueItem } from './support/orders';
import { renderApp } from './support/render-app';
import { page } from './support/vendors';

// The approval queue screen and the nav count (specs/005-submit-approve/contracts/ui.md,
// NFR-FE-08): pending orders oldest first, filters in the URL, the owner-can't-act marker.

afterEach(() => {
  vi.unstubAllGlobals();
});

const APPROVER = { ...ME, roles: ['APPROVER'] };

describe('[FR-OWN-01] the approval queue screen', () => {
  it('[FR-OWN-01] lists each waiting order with its buyer, vendor, total, step and when it was submitted', async () => {
    fakeApi({
      'GET /me': () => json(200, APPROVER),
      'GET /approvals': () =>
        json(
          200,
          page([
            queueItem(),
            queueItem({ id: 'b', poNumber: 'PO-2026-27-000124', ownerCanAct: false }),
          ]),
        ),
    });
    renderApp('/approvals');
    const table = await screen.findByRole('table', { name: 'Orders waiting for approval' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('PO-2026-27-000123');
    expect(rows[0]).toHaveTextContent('Bea Buyer');
    expect(rows[0]).toHaveTextContent('Acme Supplies');
    expect(rows[0]).toHaveTextContent('₹1,50,000.00');
    expect(rows[0]).toHaveTextContent('1 of 1');
    expect(
      within(rows[0] as HTMLElement).getByRole('link', { name: 'PO-2026-27-000123' }),
    ).toHaveAttribute('href', `/orders/${ORDER_ID}`);
    expect(rows[1]).toHaveTextContent('Owner can no longer act on this order');
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('[FR-OWN-01] says how long each order has waited, beside when it was submitted', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-20T10:00:00.000Z'));
    try {
      fakeApi({
        'GET /me': () => json(200, APPROVER),
        'GET /approvals': () => json(200, page([queueItem()])),
      });
      renderApp('/approvals');
      const table = await screen.findByRole('table', { name: 'Orders waiting for approval' });
      const [row] = within(table).getAllByRole('row').slice(1);
      expect(row).toHaveTextContent('3 days ago');
      expect(row).toHaveTextContent('17 November 2026');
      expect(
        within(row as HTMLElement)
          .getByText(/17 November 2026/)
          .closest('time'),
      ).toHaveAttribute('datetime', '2026-11-17T10:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('[FR-OWN-01] says when nothing is waiting', async () => {
    fakeApi({
      'GET /me': () => json(200, APPROVER),
      'GET /approvals': () => json(200, page([])),
    });
    renderApp('/approvals');
    expect(await screen.findByText('No orders are waiting for your approval.')).toBeInTheDocument();
  });

  it('[NFR-FE-04] keeps the PO-number filter in the URL and asks the API with it', async () => {
    const seen = fakeApi({
      'GET /me': () => json(200, APPROVER),
      'GET /approvals': () => json(200, page([queueItem()])),
    });
    renderApp('/approvals?poNumber=PO-2026-27-0001');
    expect(await screen.findByText('Sorted by PO number, newest first.')).toBeInTheDocument();
    await waitFor(() => {
      expect(
        seen.some((r) => new URL(r.url).searchParams.get('poNumber') === 'PO-2026-27-0001'),
      ).toBe(true);
    });
  });
});

describe('[NFR-FE-08] the Approvals nav link', () => {
  it('[NFR-FE-08] Approvers see how many orders wait for them; Buyers see no Approvals link', async () => {
    fakeApi({
      'GET /me': () => json(200, APPROVER),
      'GET /approvals': () => json(200, { ...page([queueItem()]), total: 3 }),
    });
    renderApp('/approvals');
    expect(
      await screen.findByRole('link', { name: 'Approvals, 3 orders waiting' }),
    ).toBeInTheDocument();
  });

  it('[NFR-FE-08] a Buyer has no Approvals link and asks nothing', async () => {
    const seen = fakeApi({
      'GET /me': () => json(200, { ...ME, roles: ['BUYER'] }),
      'GET /orders': () => json(200, page([])),
    });
    renderApp('/orders');
    await screen.findByRole('heading', { name: 'Orders' });
    expect(screen.queryByRole('link', { name: /^Approvals/ })).toBeNull();
    expect(seen.some((r) => new URL(r.url).pathname.endsWith('/approvals'))).toBe(false);
  });
});
