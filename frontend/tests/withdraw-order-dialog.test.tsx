import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axeViolations } from './support/axe';
import { fakeApi, json, ME, problem } from './support/fake-api';
import { order, ORDER_ID, pendingOrder, pendingRound } from './support/orders';
import { renderApp } from './support/render-app';
import { page, vendor } from './support/vendors';

// The Withdraw dialog (contracts/ui.md, ADR-0018; US5 scenario 5, US2 scenario 5): a
// required reason, what withdrawing means; the draft then shows why it came back; a stale
// editor offers Withdraw.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const OWNER = { ...ME, id: order().owner.id, roles: ['BUYER'] };
const WITHDRAW = `POST /orders/${ORDER_ID}/withdraw`;
const withdrawn = () =>
  order({
    version: 3,
    approval: {
      ...pendingRound(),
      outcome: 'WITHDRAWN',
      closedAt: '2026-11-17T11:00:00.000Z',
      withdrawReason: 'Wrong quantity',
      steps: [{ ...pendingRound().steps[0], state: 'VOIDED' }],
    },
  });

describe('[FR-APR-02] the Withdraw dialog', () => {
  it('[NFR-FE-09] says what withdrawing means and needs a reason', async () => {
    fakeApi({
      'GET /me': () => json(200, OWNER),
      [`GET /orders/${ORDER_ID}`]: () => json(200, pendingOrder(), { ETag: '"2"' }),
    });
    const { user } = renderApp(`/orders/${ORDER_ID}`);
    await user.click(await screen.findByRole('button', { name: 'Withdraw' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveAccessibleName('Withdraw PO-2026-27-000123?');
    expect(dialog).toHaveTextContent(
      'It returns to Draft, and approval starts again when you resubmit.',
    );
    expect(within(dialog).getByRole('button', { name: 'Keep it pending' })).toHaveFocus();
    expect(within(dialog).getByLabelText('Reason')).toBeRequired();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('[FR-APR-02] a blank reason says "Enter a reason." at the field and sends nothing', async () => {
    const seen = fakeApi({
      'GET /me': () => json(200, OWNER),
      [`GET /orders/${ORDER_ID}`]: () => json(200, pendingOrder(), { ETag: '"2"' }),
    });
    const { user } = renderApp(`/orders/${ORDER_ID}`);
    await user.click(await screen.findByRole('button', { name: 'Withdraw' }));
    const dialog = await screen.findByRole('alertdialog');
    const reason = within(dialog).getByLabelText('Reason');
    await user.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    expect(reason).toBeRequired();
    expect(reason).toBeInvalid();
    expect(reason).toHaveAccessibleDescription('Enter a reason.');
    expect(seen.filter((r) => r.method === 'POST')).toEqual([]);
    // Typing a reason clears the error.
    await user.type(reason, 'Wrong quantity');
    expect(reason).toBeValid();
  });

  it('[FR-APR-02] the server refusing the reason as too short says the same at the field', async () => {
    fakeApi({
      'GET /me': () => json(200, OWNER),
      [`GET /orders/${ORDER_ID}`]: () => json(200, pendingOrder(), { ETag: '"2"' }),
      [WITHDRAW]: () =>
        problem(400, 'VALIDATION_FAILED', {
          details: [{ path: 'body.reason', code: 'TOO_SHORT' }],
        }),
    });
    const { user } = renderApp(`/orders/${ORDER_ID}`);
    await user.click(await screen.findByRole('button', { name: 'Withdraw' }));
    const dialog = await screen.findByRole('alertdialog');
    const reason = within(dialog).getByLabelText('Reason');
    await user.type(reason, 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(reason).toHaveAccessibleDescription('Enter a reason.'));
    expect(dialog).not.toHaveTextContent('This is too short.');
  });

  it('[FR-APR-02] withdraws with If-Match and the reason; the draft says why it came back and can be edited', async () => {
    const seen = fakeApi({
      'GET /me': () => json(200, OWNER),
      [`GET /orders/${ORDER_ID}`]: () => json(200, pendingOrder(), { ETag: '"2"' }),
      [WITHDRAW]: () => json(200, withdrawn(), { ETag: '"3"' }),
      'GET /approvals': () => json(200, page([])),
    });
    const { user } = renderApp(`/orders/${ORDER_ID}`);
    await user.click(await screen.findByRole('button', { name: 'Withdraw' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByLabelText('Reason'), 'Wrong quantity');
    await user.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    expect(await screen.findByText('Withdrawn. It is a draft again.')).toBeInTheDocument();
    expect(screen.getByText('Withdrawn: Wrong quantity')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit' })).toBeInTheDocument();
    const [request] = seen.filter((r) => r.method === 'POST');
    expect(request?.headers.get('If-Match')).toBe('"2"');
    expect(await request?.json()).toEqual({ reason: 'Wrong quantity' });
  });

  it('[FR-APR-02] a stale editor told the order waits for approval offers Withdraw', async () => {
    fakeApi({
      'GET /me': () => json(200, OWNER),
      [`GET /orders/${ORDER_ID}`]: () => json(200, order(), { ETag: '"1"' }),
      [`PATCH /orders/${ORDER_ID}`]: () =>
        problem(409, 'ORDER_PENDING_APPROVAL', {
          orderState: { status: 'PENDING_APPROVAL', action: 'EDIT' },
        }),
      'GET /vendors': () => json(200, page([vendor()])),
    });
    // jsdom lays nothing out: give the virtual line table a viewport, as a browser would.
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(1024);
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(768);
    const { user } = renderApp(`/orders/${ORDER_ID}/edit`);
    const quantity = await screen.findByLabelText('Quantity, line 1');
    await user.clear(quantity);
    await user.type(quantity, '4');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    const alert = await screen.findByText(
      'This order is waiting for approval. Withdraw it to make changes.',
    );
    expect(alert).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Withdraw' })).toHaveAttribute(
      'href',
      `/orders/${ORDER_ID}`,
    );
  });

  it("[FR-APR-02] the editor's Withdraw opens the dialog once: the request is cleared, so a refresh does not reopen it", async () => {
    fakeApi({
      'GET /me': () => json(200, OWNER),
      [`GET /orders/${ORDER_ID}`]: () => json(200, pendingOrder(), { ETag: '"2"' }),
    });
    const { router } = renderApp('/');
    await router.navigate(`/orders/${ORDER_ID}`, { state: { withdraw: true } });
    expect(await screen.findByRole('alertdialog')).toHaveAccessibleName(
      'Withdraw PO-2026-27-000123?',
    );
    await waitFor(() => {
      expect(router.state.location.state).toBeNull();
    });
    expect(router.state.location.pathname).toBe(`/orders/${ORDER_ID}`);
    expect(router.state.historyAction).toBe('REPLACE');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });
});
