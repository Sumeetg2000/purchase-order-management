import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axeViolations } from './support/axe';
import { fakeApi, json, ME, problem, type Handler } from './support/fake-api';
import { order, orderLine, ORDER_ID } from './support/orders';
import { renderApp } from './support/render-app';
import { page, vendor } from './support/vendors';

// Editing a draft in the web app (contracts/ui.md; spec US3): the editor opens on the
// stored order, saves with If-Match and no confirmation, guards unsaved edits, and on a
// version conflict says so and offers to reload the order.

// jsdom lays nothing out: give the virtual line table a viewport, as a browser would.
beforeEach(() => {
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(1024);
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(768);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const EDIT_PATH = `/orders/${ORDER_ID}/edit`;
const OWNER = { ...ME, id: order().owner.id };

function editApi(handlers: Record<string, Handler> = {}) {
  return fakeApi({
    'GET /me': () => json(200, { ...OWNER, roles: ['BUYER'] }),
    'GET /vendors': () => json(200, page([vendor()])),
    [`GET /orders/${ORDER_ID}`]: () => json(200, order(), { ETag: '"1"' }),
    [`PATCH /orders/${ORDER_ID}`]: () =>
      json(200, order({ version: 2, total: '1.0875' }), { ETag: '"2"' }),
    ...handlers,
  });
}

const cell = (label: string, line: number) =>
  screen.getByLabelText(`${label}, line ${String(line)}`);
const patches = (seen: Request[]) => seen.filter((r) => r.method === 'PATCH');

describe('[FR-PO-06] edit a draft in the web app', () => {
  it('[FR-PO-06] opens on the stored order and saves the full line set with If-Match, unasked', async () => {
    const seen = editApi();
    const { user, router } = renderApp(EDIT_PATH);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Edit PO-2026-27-000123' }),
    ).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Vendor' })).toHaveValue('Acme Supplies');
    expect(await screen.findByLabelText('Description, line 1')).toHaveValue('Washers');
    expect(cell('Quantity', 2)).toHaveValue('7');
    expect(cell('Unit price', 2)).toHaveValue('0.0125');
    expect(screen.getByTestId('order-total')).toHaveTextContent('₹0.3875');

    await user.clear(cell('Quantity', 1));
    await user.type(cell('Quantity', 1), '10');
    await user.click(screen.getByRole('button', { name: 'Add line' }));
    await user.type(cell('Description', 3), 'Spacers');
    await user.type(cell('Quantity', 3), '4');
    await user.type(cell('Unit price', 3), '0.25');
    await user.click(screen.getByRole('button', { name: 'Remove line 2' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    // No confirmation: a save is reversible.
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/orders/${ORDER_ID}`);
    });
    const [patch] = patches(seen);
    expect(patch?.headers.get('If-Match')).toBe('"1"');
    expect(await patch?.json()).toEqual({
      vendorId: order().vendor.id,
      lines: [
        { id: orderLine().id, description: 'Washers', quantity: 10, unitPrice: '0.1000' },
        { description: 'Spacers', quantity: 4, unitPrice: '0.25' },
      ],
    });
  });

  it('[NFR-FE-09] asks before leaving with unsaved edits, in the app and on unload', async () => {
    editApi();
    const { user, router } = renderApp(EDIT_PATH);
    await user.type(await screen.findByLabelText('Description, line 1'), ' M8');
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await user.click(screen.getByRole('link', { name: 'Cancel' }));
    expect(await screen.findByRole('alertdialog')).toHaveAccessibleName(
      'Discard your unsaved changes?',
    );
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(router.state.location.pathname).toBe(EDIT_PATH);
    expect(cell('Description', 1)).toHaveValue('Washers M8');
  });

  it('[NFR-FE-01] a version conflict says the order changed, and Reload order starts again from what is stored', async () => {
    let reads = 0;
    const seen = editApi({
      [`GET /orders/${ORDER_ID}`]: () => {
        reads += 1;
        return reads === 1
          ? json(200, order(), { ETag: '"1"' })
          : json(
              200,
              order({
                version: 3,
                lines: [orderLine({ description: 'Hex washers' })],
                lineCount: 1,
              }),
              { ETag: '"3"' },
            );
      },
      [`PATCH /orders/${ORDER_ID}`]: () => problem(409, 'VERSION_CONFLICT'),
    });
    const { user } = renderApp(EDIT_PATH);
    await user.type(await screen.findByLabelText('Description, line 1'), ' M8');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This order changed since you opened it.',
    );
    await user.click(screen.getByRole('button', { name: 'Reload order' }));
    expect(await screen.findByRole('alertdialog')).toHaveAccessibleName(
      'Discard your unsaved changes?',
    );
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => {
      expect(cell('Description', 1)).toHaveValue('Hex washers');
    });
    expect(screen.queryByLabelText('Description, line 2')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    await user.type(cell('Description', 1), ' M8');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(patches(seen)).toHaveLength(2);
    });
    expect(patches(seen)[1]?.headers.get('If-Match')).toBe('"3"');
  });

  it('[NFR-FE-03] has no automated accessibility violations', async () => {
    editApi();
    renderApp(EDIT_PATH);
    await screen.findByLabelText('Description, line 1');
    expect(await axeViolations(document.body)).toEqual([]);
  });
});

describe('[FR-PO-06] the Edit action on an order', () => {
  it('[FR-PO-06] the owner of a draft gets Edit; another reader does not', async () => {
    editApi();
    const { user, router } = renderApp(`/orders/${ORDER_ID}`);
    await user.click(await screen.findByRole('link', { name: 'Edit' }));
    expect(router.state.location.pathname).toBe(EDIT_PATH);
  });

  it('[FR-PO-06] an Admin reading the draft gets no Edit', async () => {
    fakeApi({
      'GET /me': () => json(200, { ...ME, roles: ['ADMIN'] }),
      [`GET /orders/${ORDER_ID}`]: () => json(200, order(), { ETag: '"1"' }),
    });
    renderApp(`/orders/${ORDER_ID}`);
    await screen.findByRole('heading', { level: 1, name: 'PO-2026-27-000123' });
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
  });
});
