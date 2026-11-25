import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axeViolations } from './support/axe';
import { fakeApi, json, ME, problem } from './support/fake-api';
import { approvedOrder, cancelledOrder, orderLine, ORDER_ID } from './support/orders';
import { renderApp } from './support/render-app';
import { page } from './support/vendors';

// Cancelling an order with receipts, on the web (US5, FR-020; contracts/ui.md): the Cancel
// dialog shows each line's ordered and received quantity and the received summary; a
// fully received order offers no Cancel and no owner-can't-act marker, and a cancel refused
// as fully received says so inside the dialog with Reload order; a cancelled order's page
// shows the summary and, per line, how much of it was received.

afterEach(() => {
  vi.unstubAllGlobals();
});

const APPROVER = { ...ME, id: '0192e4a0-0000-7000-8000-00000000aaaa', roles: ['APPROVER'] };
const LINE_B = '0192e4a0-0000-7000-8000-0000000000c2';

/** Washers 60 of 100 received, Bolts 7 of 7. */
const receivedLines = () => [
  orderLine({ quantity: 100, receivedQuantity: 60 }),
  orderLine({ id: LINE_B, description: 'Bolts', quantity: 7, receivedQuantity: 7 }),
];

function show(shown: Record<string, unknown>, cancel?: () => Response) {
  fakeApi({
    'GET /me': () => json(200, APPROVER),
    [`GET /orders/${ORDER_ID}`]: () => json(200, shown, { ETag: '"3"' }),
    [`GET /orders/${ORDER_ID}/receipts`]: () => json(200, page([])),
    'GET /approvals': () => json(200, page([])),
    ...(cancel ? { [`POST /orders/${ORDER_ID}/cancel`]: cancel } : {}),
  });
  return renderApp(`/orders/${ORDER_ID}`);
}

const heading = () => screen.findByRole('heading', { level: 1, name: 'PO-2026-27-000123' });

describe('[FR-LCK-02] the Cancel dialog with receipts', () => {
  it('[NFR-FE-09] shows each line ordered and received and the summary, not "nothing received"', async () => {
    const { user } = show(
      approvedOrder({ lines: receivedLines(), receiptProgress: 'PARTIALLY_RECEIVED' }),
    );
    await user.click(await screen.findByRole('button', { name: 'Cancel order' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Line 1, Washers: ordered 100, received 60');
    expect(dialog).toHaveTextContent('Line 2, Bolts: ordered 7, received 7');
    expect(dialog).toHaveTextContent('1 of 2 lines complete, 1 partly received');
    expect(dialog).not.toHaveTextContent('Nothing has been received against this order.');
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('[FR-LCK-02] a cancel refused as fully received says so inside, with Reload order', async () => {
    const { user } = show(
      approvedOrder({ lines: receivedLines(), receiptProgress: 'PARTIALLY_RECEIVED' }),
      () => problem(409, 'ORDER_FULLY_RECEIVED'),
    );
    await user.click(await screen.findByRole('button', { name: 'Cancel order' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByLabelText('Reason'), 'Supplier closed');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      "This order has been fully received, so it can't be cancelled.",
    );
    expect(within(dialog).getByRole('button', { name: 'Reload order' })).toBeInTheDocument();
  });
});

describe('[FR-LCK-02] a fully received order', () => {
  it("[FR-LCK-02] offers no Cancel, and no owner-can't-act marker even when its owner can't act", async () => {
    show(
      approvedOrder({
        lines: [orderLine({ receivedQuantity: 3 })],
        receiptProgress: 'FULLY_RECEIVED',
        ownerCanAct: false,
      }),
    );
    await heading();
    expect(screen.getByText('Fully received')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel order' })).not.toBeInTheDocument();
    expect(screen.queryByText(/can no longer act on it/)).not.toBeInTheDocument();
  });
});

describe('[FR-LCK-02] a cancelled order with receipts', () => {
  it('[FR-LCK-02] shows the cancelled summary and, per line, how much was received', async () => {
    show(cancelledOrder({ lines: receivedLines(), receiptProgress: 'PARTIALLY_RECEIVED' }));
    await heading();
    expect(
      screen.getByText('Cancelled · 1 of 2 lines complete, 1 partly received'),
    ).toBeInTheDocument();
    const section = screen.getByRole('region', { name: 'Cancellation' });
    expect(section).toHaveTextContent('Line 1, Washers: 60 of 100 received');
    expect(section).toHaveTextContent('Line 2, Bolts: 7 of 7 received');
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
