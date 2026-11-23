import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axeViolations } from './support/axe';
import { fakeApi, json, ME, problem } from './support/fake-api';
import { approvedOrder, cancelledOrder, ORDER_ID } from './support/orders';
import { renderApp } from './support/render-app';
import { page } from './support/vendors';

// The Cancel dialog (contracts/ui.md, ADR-0018; US1 scenario 7): it names the order, its
// buyer, vendor and total and what was received, needs a reason, says cancelling is final,
// and starts on the safe choice.

afterEach(() => {
  vi.unstubAllGlobals();
});

const APPROVER = { ...ME, id: '0192e4a0-0000-7000-8000-00000000aaaa', roles: ['APPROVER'] };
const CANCEL = `POST /orders/${ORDER_ID}/cancel`;

function cancelApi(cancel = () => json(200, cancelledOrder(), { ETag: '"4"' })) {
  let cancelled = false;
  return fakeApi({
    'GET /me': () => json(200, APPROVER),
    [`GET /orders/${ORDER_ID}`]: () =>
      cancelled
        ? json(200, cancelledOrder(), { ETag: '"4"' })
        : json(200, approvedOrder(), { ETag: '"3"' }),
    'GET /approvals': () => json(200, page([])),
    [CANCEL]: () => {
      const res = cancel();
      if (res.status === 200) cancelled = true;
      return res;
    },
  });
}

async function openDialog() {
  const { user } = renderApp(`/orders/${ORDER_ID}`);
  await user.click(await screen.findByRole('button', { name: 'Cancel order' }));
  return { user, dialog: await screen.findByRole('alertdialog') };
}

describe('[FR-LCK-02] the Cancel dialog', () => {
  it('[NFR-FE-09] names the order, buyer, vendor and total, says it is final, starts on Keep order', async () => {
    cancelApi();
    const { dialog } = await openDialog();
    expect(dialog).toHaveAccessibleName('Cancel PO-2026-27-000123?');
    expect(dialog).toHaveTextContent('Bea Buyer');
    expect(dialog).toHaveTextContent('Acme Supplies (as submitted)');
    expect(dialog).toHaveTextContent('₹1,50,000.00');
    expect(dialog).toHaveTextContent('Nothing has been received against this order.');
    expect(dialog).toHaveTextContent(
      'Cancelling is final. No further goods can be received against this order.',
    );
    expect(within(dialog).getByRole('button', { name: 'Keep order' })).toHaveFocus();
    expect(within(dialog).getByLabelText('Reason')).toBeRequired();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('[NFR-VAL-01] a blank reason says "Enter a reason." at the field and sends nothing', async () => {
    const seen = cancelApi();
    const { user, dialog } = await openDialog();
    const reason = within(dialog).getByLabelText('Reason');
    await user.type(reason, '   ');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));
    expect(reason).toBeInvalid();
    expect(reason).toHaveAccessibleDescription('Enter a reason.');
    expect(seen.filter((r) => r.method === 'POST')).toEqual([]);
  });

  it('[NFR-VAL-01] the server refusing the reason as too short says the same at the field', async () => {
    cancelApi(() =>
      problem(400, 'VALIDATION_FAILED', { details: [{ path: 'body.reason', code: 'TOO_SHORT' }] }),
    );
    const { user, dialog } = await openDialog();
    await user.type(within(dialog).getByLabelText('Reason'), 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));
    await waitFor(() => {
      expect(within(dialog).getByLabelText('Reason')).toHaveAccessibleDescription(
        'Enter a reason.',
      );
    });
  });

  it('[FR-LCK-02] sends the reason with If-Match, closes, and the page shows the order cancelled', async () => {
    const seen = cancelApi();
    const { user, dialog } = await openDialog();
    await user.type(within(dialog).getByLabelText('Reason'), 'Supplier closed');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    const post = seen.find((r) => r.method === 'POST');
    expect(post?.headers.get('If-Match')).toBe('"3"');
    expect(await post?.clone().json()).toEqual({ reason: 'Supplier closed' });
    expect(await screen.findByRole('region', { name: 'Cancellation' })).toHaveTextContent(
      'Supplier closed',
    );
    expect(screen.queryByRole('button', { name: 'Cancel order' })).toBeNull();
  });

  it("[FR-SOD-01] SELF_APPROVAL says the cancel's own words", async () => {
    cancelApi(() => problem(403, 'SELF_APPROVAL'));
    const { user, dialog } = await openDialog();
    await user.type(within(dialog).getByLabelText('Reason'), 'Mine');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      "You can't cancel an order you raised.",
    );
  });
});
