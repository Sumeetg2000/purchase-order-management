import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axeViolations } from './support/axe';
import { fakeApi, json, ME, problem, type Handler } from './support/fake-api';
import { order, ORDER_ID, pendingOrder, pendingRound, policy } from './support/orders';
import { renderApp } from './support/render-app';
import { page } from './support/vendors';

// The Submit order dialog (specs/005-submit-approve/contracts/ui.md, ADR-0018; US1
// scenario 7): the saved total, the expected outcome from the published policy, what
// submitting means; the page shows the actual outcome after.

afterEach(() => {
  vi.unstubAllGlobals();
});

const OWNER = { ...ME, id: order().owner.id };
const SUBMIT = `POST /orders/${ORDER_ID}/submit`;

function submitApi(draft: Record<string, unknown>, handlers: Record<string, Handler> = {}) {
  return fakeApi({
    'GET /me': () => json(200, { ...OWNER, roles: ['BUYER'] }),
    [`GET /orders/${ORDER_ID}`]: () => json(200, draft, { ETag: '"1"' }),
    'GET /approval-policy': () => json(200, policy()),
    'GET /orders': () => json(200, page([])),
    [SUBMIT]: () => json(200, pendingOrder(), { ETag: '"2"' }),
    ...handlers,
  });
}

async function openDialog() {
  const view = renderApp(`/orders/${ORDER_ID}`);
  await view.user.click(await screen.findByRole('button', { name: 'Submit' }));
  const dialog = await screen.findByRole('alertdialog');
  return { ...view, dialog };
}

describe('[FR-APR-01] the Submit order dialog', () => {
  it('[FR-APR-01] if the policy cannot be read, says the expected outcome is unavailable', async () => {
    submitApi(order({ total: '150000.0000' }), {
      'GET /approval-policy': () => problem(500, 'INTERNAL_ERROR'),
    });
    const { dialog } = await openDialog();
    expect(
      await within(dialog).findByText(
        "The expected outcome isn't available right now; submitting still routes the order.",
        { exact: false },
      ),
    ).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('Checking the approval policy');
  });

  it('[NFR-FE-09] names the order and total, the expected approval, and what submitting means', async () => {
    submitApi(order({ total: '150000.0000' }));
    const { dialog } = await openDialog();
    expect(dialog).toHaveAccessibleName('Submit PO-2026-27-000123?');
    expect(dialog).toHaveTextContent('₹1,50,000.00');
    expect(dialog).toHaveTextContent('Will go to the Approver for approval');
    expect(dialog).toHaveTextContent(
      "You can't edit it after submitting; you can withdraw it while it's pending.",
    );
    expect(dialog).toHaveTextContent('expected');
    expect(within(dialog).getByRole('button', { name: 'Keep editing' })).toHaveFocus();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('[FR-APR-01] at or below the lowest tier it expects an auto-approval', async () => {
    submitApi(order({ total: '100000.0000' }));
    const { dialog } = await openDialog();
    expect(dialog).toHaveTextContent('Will be auto-approved');
  });

  it('[FR-APR-01] submits with If-Match and no body, then shows the actual outcome', async () => {
    const seen = submitApi(order({ total: '150000.0000' }));
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('Submitted. It is waiting for approval.')).toHaveAttribute(
      'role',
      'status',
    );
    const [request] = seen.filter((r) => r.method === 'POST');
    expect(request?.headers.get('If-Match')).toBe('"1"');
    expect(await request?.text()).toBe('');
    expect(screen.getByText('Pending approval')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
  });

  it('[FR-APR-01] an auto-approval is said as such', async () => {
    submitApi(order({ total: '10.0000' }), {
      [SUBMIT]: () =>
        json(
          200,
          pendingOrder({
            status: 'APPROVED',
            approvedAt: '2026-11-17T10:00:00.000Z',
            approval: { ...pendingRound(), outcome: 'AUTO_APPROVED', steps: [] },
          }),
          { ETag: '"2"' },
        ),
    });
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('Submitted and approved automatically.')).toBeInTheDocument();
  });

  it('[NFR-FE-01] a failure stays inside the dialog; a version conflict offers Reload order', async () => {
    submitApi(order(), {
      [SUBMIT]: () => problem(409, 'VERSION_CONFLICT'),
    });
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Submit' }));
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: 'Reload order' })).toBeInTheDocument();
    });
  });

  it('[FR-VEN-03] an inactive vendor is said inside the dialog', async () => {
    submitApi(order(), { [SUBMIT]: () => problem(409, 'VENDOR_INACTIVE') });
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Submit' }));
    expect(await within(dialog).findByText(/This vendor is deactivated/)).toBeInTheDocument();
  });
});

describe('[FR-LCK-01] a submitted order is read-only', () => {
  it('[FR-LCK-01] shows the vendor as submitted and the approval chain, with no Edit, Delete or Submit', async () => {
    fakeApi({
      'GET /me': () => json(200, { ...OWNER, roles: ['BUYER'] }),
      [`GET /orders/${ORDER_ID}`]: () => json(200, pendingOrder(), { ETag: '"2"' }),
    });
    renderApp(`/orders/${ORDER_ID}`);
    expect(await screen.findByText('Acme Supplies (as submitted)')).toBeInTheDocument();
    const chain = screen.getByRole('region', { name: 'Approval' });
    expect(chain).toHaveTextContent('Step 1');
    expect(chain).toHaveTextContent('₹1,00,000.00');
    expect(chain).toHaveTextContent('Waiting');
    for (const name of ['Edit', 'Delete draft', 'Submit']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
      expect(screen.queryByRole('link', { name })).toBeNull();
    }
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('[FR-SM-03] a decided step shows who decided and, for a rejection, why', async () => {
    const rejected = pendingOrder({
      status: 'REJECTED',
      approval: {
        ...pendingRound(),
        outcome: 'REJECTED',
        closedAt: '2026-11-17T11:00:00.000Z',
        steps: [
          {
            ...pendingRound().steps[0],
            state: 'REJECTED',
            decidedBy: { id: ME.id, name: 'Priya Approver' },
            decidedAt: '2026-11-17T11:00:00.000Z',
            reason: 'Too dear',
          },
        ],
      },
    });
    fakeApi({
      'GET /me': () => json(200, { ...OWNER, roles: ['BUYER'] }),
      [`GET /orders/${ORDER_ID}`]: () => json(200, rejected, { ETag: '"3"' }),
    });
    renderApp(`/orders/${ORDER_ID}`);
    const chain = await screen.findByRole('region', { name: 'Approval' });
    expect(chain).toHaveTextContent('Rejected by Priya Approver');
    expect(chain).toHaveTextContent('Too dear');
  });
});
