import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axeViolations } from './support/axe';
import { fakeApi, json, ME, problem } from './support/fake-api';
import { ORDER_ID, pendingOrder, pendingRound } from './support/orders';
import { renderApp } from './support/render-app';
import { page } from './support/vendors';

// The Reject dialog (contracts/ui.md, ADR-0018; US4 scenario 6): a required reason, the
// rejection is final, the safe choice focused; offered beside Approve, and alone when the
// owner can no longer act.

afterEach(() => {
  vi.unstubAllGlobals();
});

const APPROVER = { ...ME, id: '0192e4a0-0000-7000-8000-00000000aaaa', roles: ['APPROVER'] };
const REJECT = `POST /orders/${ORDER_ID}/reject`;

function rejectApi(order: Record<string, unknown>) {
  return fakeApi({
    'GET /me': () => json(200, APPROVER),
    [`GET /orders/${ORDER_ID}`]: () => json(200, order, { ETag: '"2"' }),
    'GET /approvals': () => json(200, page([])),
    [REJECT]: () =>
      json(
        200,
        pendingOrder({
          status: 'REJECTED',
          version: 3,
          approval: {
            ...pendingRound(),
            outcome: 'REJECTED',
            closedAt: '2026-11-17T11:00:00.000Z',
          },
        }),
        { ETag: '"3"' },
      ),
  });
}

describe('[FR-SM-03] the Reject dialog', () => {
  it('[NFR-FE-09] says rejection is final, needs a reason, and starts on the safe choice', async () => {
    rejectApi(pendingOrder());
    const { user } = renderApp(`/orders/${ORDER_ID}`);
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveAccessibleName('Reject PO-2026-27-000123?');
    expect(dialog).toHaveTextContent('Rejection is final; the buyer must raise a new order.');
    expect(within(dialog).getByRole('button', { name: 'Not now' })).toHaveFocus();
    expect(within(dialog).getByLabelText('Reason')).toBeRequired();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('[FR-SM-03] a blank reason says "Enter a reason." at the field and sends nothing', async () => {
    const seen = rejectApi(pendingOrder());
    const { user } = renderApp(`/orders/${ORDER_ID}`);
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('alertdialog');
    const reason = within(dialog).getByLabelText('Reason');
    await user.type(reason, '   ');
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(reason).toBeRequired();
    expect(reason).toBeInvalid();
    expect(reason).toHaveAccessibleDescription('Enter a reason.');
    expect(reason).toHaveFocus();
    expect(seen.filter((r) => r.method === 'POST')).toEqual([]);
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('[FR-SM-03] the server refusing the reason as too short says the same at the field', async () => {
    fakeApi({
      'GET /me': () => json(200, APPROVER),
      [`GET /orders/${ORDER_ID}`]: () => json(200, pendingOrder(), { ETag: '"2"' }),
      'GET /approvals': () => json(200, page([])),
      [REJECT]: () =>
        problem(400, 'VALIDATION_FAILED', {
          details: [{ path: 'body.reason', code: 'TOO_SHORT' }],
        }),
    });
    const { user } = renderApp(`/orders/${ORDER_ID}`);
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('alertdialog');
    const reason = within(dialog).getByLabelText('Reason');
    await user.type(reason, 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(reason).toHaveAccessibleDescription('Enter a reason.'));
    expect(reason).toBeInvalid();
    expect(dialog).not.toHaveTextContent('This is too short.');
  });

  it('[FR-SM-03] rejects with If-Match and the reason, then shows the order rejected', async () => {
    const seen = rejectApi(pendingOrder());
    const { user } = renderApp(`/orders/${ORDER_ID}`);
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByLabelText('Reason'), ' Quote too high ');
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('Rejected.')).toBeInTheDocument();
    const [request] = seen.filter((r) => r.method === 'POST');
    expect(request?.headers.get('If-Match')).toBe('"2"');
    expect(await request?.json()).toEqual({ reason: 'Quote too high' });
  });

  it('[FR-APR-01] while the owner can no longer act: the marker, Reject offered, no Approve', async () => {
    rejectApi(pendingOrder({ ownerCanAct: false }));
    renderApp(`/orders/${ORDER_ID}`);
    expect(await screen.findByText('Owner can no longer act on this order')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});
