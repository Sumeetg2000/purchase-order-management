import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorMessages } from '../src/errors/messages';
import { axeViolations } from './support/axe';
import { fakeApi, json, ME, problem, type Handler } from './support/fake-api';
import { order, ORDER_ID } from './support/orders';
import { renderApp } from './support/render-app';
import { page } from './support/vendors';

// The Delete draft dialog (contracts/ui.md; spec US4, NFR-FE-09): it names the draft, its
// vendor, lines and total, says the deletion is permanent and hides the draft's history
// from its owner, starts on the safe button, takes an optional reason, and shows a failure
// inside itself, with Reload order after a version conflict.

afterEach(() => {
  vi.unstubAllGlobals();
});

const OWNER = { ...ME, id: order().owner.id };
const DELETE = `DELETE /orders/${ORDER_ID}`;

function deleteApi(handlers: Record<string, Handler> = {}) {
  return fakeApi({
    'GET /me': () => json(200, { ...OWNER, roles: ['BUYER'] }),
    [`GET /orders/${ORDER_ID}`]: () => json(200, order(), { ETag: '"1"' }),
    'GET /orders': () => json(200, page([])),
    [DELETE]: () => new Response(null, { status: 204 }),
    ...handlers,
  });
}

async function openDialog() {
  const view = renderApp(`/orders/${ORDER_ID}`);
  await view.user.click(await screen.findByRole('button', { name: 'Delete draft' }));
  const dialog = await screen.findByRole('alertdialog');
  return { ...view, dialog };
}

const deletes = (seen: Request[]) => seen.filter((r) => r.method === 'DELETE');

describe('[FR-SM-02] the Delete draft dialog', () => {
  it('[NFR-FE-09] names the draft, its vendor, lines and total, and what deleting it means', async () => {
    deleteApi();
    const { dialog } = await openDialog();
    expect(dialog).toHaveAccessibleName('Delete draft PO-2026-27-000123?');
    expect(dialog).toHaveTextContent('Acme Supplies');
    expect(dialog).toHaveTextContent('2 lines');
    expect(dialog).toHaveTextContent('₹0.3875');
    expect(dialog).toHaveTextContent('This permanently deletes the draft.');
    expect(dialog).toHaveTextContent("You won't be able to see this draft or its history again.");
    expect(within(dialog).getByRole('button', { name: 'Keep draft' })).toHaveFocus();
    expect(within(dialog).getByLabelText('Reason (optional)')).toBeInTheDocument();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('[FR-SM-02] deletes with If-Match and no reason, then shows the orders list', async () => {
    const seen = deleteApi();
    const { user, dialog, router } = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Delete draft' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/orders');
    });
    const [request] = deletes(seen);
    expect(request?.headers.get('If-Match')).toBe('"1"');
    expect(await request?.text()).toBe('');
  });

  it('[FR-SM-02] sends a reason when one is given', async () => {
    const seen = deleteApi();
    const { user, dialog } = await openDialog();
    await user.type(within(dialog).getByLabelText('Reason (optional)'), '  Raised twice ');
    await user.click(within(dialog).getByRole('button', { name: 'Delete draft' }));
    await waitFor(() => {
      expect(deletes(seen)).toHaveLength(1);
    });
    expect(await deletes(seen)[0]?.json()).toEqual({ reason: 'Raised twice' });
  });

  it('[NFR-FE-04] is disabled while the delete runs, so a double click sends one request', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const seen = deleteApi({
      [DELETE]: async () => {
        await held;
        return new Response(null, { status: 204 });
      },
    });
    const { user, dialog } = await openDialog();
    await user.dblClick(within(dialog).getByRole('button', { name: 'Delete draft' }));
    // While pending the button's name also says so, hence the pattern.
    expect(within(dialog).getByRole('button', { name: /Delete draft/ })).toBeDisabled();
    release();
    await waitFor(() => {
      expect(deletes(seen)).toHaveLength(1);
    });
  });

  it('[NFR-FE-01] a version conflict shows inside the dialog with Reload order', async () => {
    let reads = 0;
    deleteApi({
      [`GET /orders/${ORDER_ID}`]: () => {
        reads += 1;
        return json(200, order({ version: reads === 1 ? 1 : 2 }), {
          ETag: `"${String(reads === 1 ? 1 : 2)}"`,
        });
      },
      [DELETE]: () => problem(409, 'VERSION_CONFLICT'),
    });
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Delete draft' }));
    expect(await within(dialog).findByText(errorMessages.VERSION_CONFLICT.message)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Reload order' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(reads).toBeGreaterThan(1);
  });

  it('[FR-PO-06] only the owner of a draft is offered Delete draft', async () => {
    fakeApi({
      'GET /me': () => json(200, { ...ME, roles: ['ADMIN'] }),
      [`GET /orders/${ORDER_ID}`]: () => json(200, order(), { ETag: '"1"' }),
    });
    renderApp(`/orders/${ORDER_ID}`);
    await screen.findByRole('heading', { level: 1, name: 'PO-2026-27-000123' });
    expect(screen.queryByRole('button', { name: 'Delete draft' })).toBeNull();
  });
});
