import { API_PATH_PREFIX, ORDER_ADMIN_READ_ONLY_MESSAGE } from '@po/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMessages, fieldMessages } from '../src/errors/messages';
import { axeViolations } from './support/axe';
import { fakeApi, json, ME, problem, type Handler } from './support/fake-api';
import { order, ORDER_ID } from './support/orders';
import { renderApp } from './support/render-app';
import { ACME_ID, page, vendor } from './support/vendors';

// Raising a draft in the web app (specs/004-draft-orders/contracts/ui.md; spec US1): the
// line editor with live exact totals, row-level validation, one request per save, an
// Idempotency-Key per create attempt reused on its retry, and the detail it lands on.

// jsdom lays nothing out, so the virtual line table would measure its viewport as 0 high
// and render no row: give elements a viewport-sized box, as a browser would.
beforeEach(() => {
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(1024);
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(768);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function editorApi(handlers: Record<string, Handler> = {}, roles = ['BUYER']) {
  return fakeApi({
    'GET /me': () => json(200, { ...ME, roles }),
    'GET /vendors': () => json(200, page([vendor()])),
    'POST /orders': () =>
      json(201, order(), { ETag: '"1"', Location: `${API_PATH_PREFIX}/orders/${ORDER_ID}` }),
    [`GET /orders/${ORDER_ID}`]: () => json(200, order(), { ETag: '"1"' }),
    ...handlers,
  });
}

const cell = (label: string, line: number) =>
  screen.getByLabelText(`${label}, line ${String(line)}`);

async function pickVendor(user: ReturnType<typeof renderApp>['user']) {
  await user.type(await screen.findByRole('combobox', { name: 'Vendor' }), 'Ac');
  await user.click(await screen.findByRole('option', { name: 'Acme Supplies' }));
}

async function fillLine(
  user: ReturnType<typeof renderApp>['user'],
  line: number,
  {
    description,
    quantity,
    unitPrice,
  }: { description: string; quantity: string; unitPrice: string },
) {
  // The page loads lazily: wait for the line before typing.
  await user.type(await screen.findByLabelText(`Description, line ${String(line)}`), description);
  await user.type(cell('Quantity', line), quantity);
  await user.type(cell('Unit price', line), unitPrice);
}

const posts = (seen: Request[]) => seen.filter((r) => r.method === 'POST');

describe('[FR-PO-01] the order editor', () => {
  it('[FR-PO-07] shows each line total and the order total live, exactly, in rupees', async () => {
    editorApi();
    const { user } = renderApp('/orders/new');
    expect(await screen.findByRole('heading', { level: 1, name: 'New order' })).toBeVisible();
    expect(screen.getByText('Total')).toBeVisible();
    expect(screen.getByTestId('order-total')).toHaveTextContent('₹0.00');

    await fillLine(user, 1, { description: 'Washers', quantity: '3', unitPrice: '0.1' });
    expect(screen.getByTestId('line-total-1')).toHaveTextContent('₹0.30');
    await user.click(screen.getByRole('button', { name: 'Add line' }));
    await fillLine(user, 2, { description: 'Bolts', quantity: '7', unitPrice: '0.0125' });
    expect(screen.getByTestId('line-total-2')).toHaveTextContent('₹0.0875');
    expect(screen.getByTestId('order-total')).toHaveTextContent('₹0.3875');

    // The largest line, beyond any float's exact range.
    await user.clear(cell('Quantity', 1));
    await user.type(cell('Quantity', 1), '1000000');
    await user.clear(cell('Unit price', 1));
    await user.type(cell('Unit price', 1), '999999999.9999');
    expect(screen.getByTestId('line-total-1')).toHaveTextContent('₹99,99,99,99,99,99,900.00');
    expect(screen.getByTestId('order-total')).toHaveTextContent('₹99,99,99,99,99,99,900.0875');
  });

  it('[NFR-FE-06] adds, removes and moves lines', async () => {
    editorApi();
    const { user } = renderApp('/orders/new');
    await fillLine(user, 1, { description: 'First', quantity: '1', unitPrice: '1' });
    await user.click(screen.getByRole('button', { name: 'Add line' }));
    await fillLine(user, 2, { description: 'Second', quantity: '2', unitPrice: '2' });
    await user.click(screen.getByRole('button', { name: 'Move line 2 up' }));
    expect(cell('Description', 1)).toHaveValue('Second');
    expect(cell('Description', 2)).toHaveValue('First');
    await user.click(screen.getByRole('button', { name: 'Remove line 1' }));
    expect(cell('Description', 1)).toHaveValue('First');
    expect(screen.queryByLabelText('Description, line 2')).toBeNull();
    expect(screen.getByTestId('order-total')).toHaveTextContent('₹1.00');
    // The last line can't be removed: an order has at least one.
    expect(screen.getByRole('button', { name: 'Remove line 1' })).toBeDisabled();
  });

  it("[NFR-FE-06] says each line's errors next to its field and keeps Create disabled until they are fixed", async () => {
    editorApi();
    const { user } = renderApp('/orders/new');
    await pickVendor(user);
    await fillLine(user, 1, { description: 'Washers', quantity: '0', unitPrice: '12.34567' });
    expect(cell('Quantity', 1)).toHaveAccessibleDescription(fieldMessages.OUT_OF_RANGE);
    expect(cell('Unit price', 1)).toHaveAccessibleDescription(fieldMessages.INVALID_FORMAT);
    expect(screen.getByTestId('line-total-1')).toHaveTextContent('—');
    expect(screen.getByRole('button', { name: 'Create order' })).toBeDisabled();
    await user.clear(cell('Quantity', 1));
    await user.type(cell('Quantity', 1), '3');
    await user.clear(cell('Unit price', 1));
    await user.type(cell('Unit price', 1), '0.1');
    expect(cell('Quantity', 1)).not.toHaveAccessibleDescription();
    expect(screen.getByRole('button', { name: 'Create order' })).toBeEnabled();
  });

  it('[FR-PO-01] creates the order, prices as typed strings, and opens it', async () => {
    const seen = editorApi();
    const { user, router } = renderApp('/orders/new');
    await pickVendor(user);
    await fillLine(user, 1, { description: ' Washers ', quantity: '3', unitPrice: '0.1' });
    await user.click(screen.getByRole('button', { name: 'Add line' }));
    await fillLine(user, 2, { description: 'Bolts', quantity: '7', unitPrice: '0.0125' });
    await user.click(screen.getByRole('button', { name: 'Create order' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/orders/${ORDER_ID}`);
    });
    const [post] = posts(seen);
    expect(await post?.json()).toEqual({
      vendorId: ACME_ID,
      lines: [
        { description: ' Washers ', quantity: 3, unitPrice: '0.1' },
        { description: 'Bolts', quantity: 7, unitPrice: '0.0125' },
      ],
    });
    expect(post?.headers.get('Idempotency-Key')).toMatch(UUID);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'PO-2026-27-000123' }),
    ).toBeVisible();
  });

  it('[NFR-FE-04] a double click sends one request', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const seen = editorApi({
      'POST /orders': async () => {
        await held;
        return json(201, order(), { ETag: '"1"' });
      },
    });
    const { user } = renderApp('/orders/new');
    await pickVendor(user);
    await fillLine(user, 1, { description: 'Washers', quantity: '3', unitPrice: '0.1' });
    await user.dblClick(screen.getByRole('button', { name: 'Create order' }));
    expect(screen.getByRole('button', { name: 'Create order' })).toBeDisabled();
    release();
    await screen.findByRole('heading', { level: 1, name: 'PO-2026-27-000123' });
    expect(posts(seen)).toHaveLength(1);
  });

  it('[NFR-CON-01] a retry of the same attempt reuses its Idempotency-Key; a changed order gets a new one', async () => {
    let calls = 0;
    const seen = editorApi({
      'POST /orders': () => {
        calls += 1;
        return calls <= 2
          ? problem(503, 'SERVICE_UNAVAILABLE', { headers: { 'Retry-After': '1' } })
          : json(201, order(), { ETag: '"1"' });
      },
    });
    const { user } = renderApp('/orders/new');
    await pickVendor(user);
    await fillLine(user, 1, { description: 'Washers', quantity: '3', unitPrice: '0.1' });
    await user.click(screen.getByRole('button', { name: 'Create order' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      errorMessages.SERVICE_UNAVAILABLE.message,
    );
    // The same order sent again: the same attempt.
    await user.click(screen.getByRole('button', { name: 'Create order' }));
    await waitFor(() => {
      expect(posts(seen)).toHaveLength(2);
    });
    // Changed, it is a new attempt with a new key.
    await user.clear(cell('Quantity', 1));
    await user.type(cell('Quantity', 1), '4');
    await user.click(screen.getByRole('button', { name: 'Create order' }));
    await screen.findByRole('heading', { level: 1, name: 'PO-2026-27-000123' });
    const keys = posts(seen).map((r) => r.headers.get('Idempotency-Key'));
    expect(keys).toHaveLength(3);
    expect(keys[0]).toMatch(UUID);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toMatch(UUID);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('[NFR-CON-01] each new order starts a new attempt with its own key', async () => {
    const seen = editorApi();
    const first = renderApp('/orders/new');
    await pickVendor(first.user);
    await fillLine(first.user, 1, { description: 'Washers', quantity: '3', unitPrice: '0.1' });
    await first.user.click(screen.getByRole('button', { name: 'Create order' }));
    await screen.findByRole('heading', { level: 1, name: 'PO-2026-27-000123' });
    await first.router.navigate('/orders/new');
    await pickVendor(first.user);
    await fillLine(first.user, 1, { description: 'Washers', quantity: '3', unitPrice: '0.1' });
    await first.user.click(screen.getByRole('button', { name: 'Create order' }));
    await waitFor(() => {
      expect(posts(seen)).toHaveLength(2);
    });
    const [a, b] = posts(seen).map((r) => r.headers.get('Idempotency-Key'));
    expect(a).not.toBe(b);
  });

  it('[FR-VEN-02] a deactivated vendor is named in a banner and focus moves to the vendor picker', async () => {
    editorApi({ 'POST /orders': () => problem(409, 'VENDOR_INACTIVE') });
    const { user } = renderApp('/orders/new');
    await pickVendor(user);
    await fillLine(user, 1, { description: 'Washers', quantity: '3', unitPrice: '0.1' });
    await user.click(screen.getByRole('button', { name: 'Create order' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Acme Supplies is deactivated. Choose another vendor.',
    );
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Vendor' })).toHaveFocus();
    });
  });

  it('[NFR-FE-03] the vendor picker asks for active vendors only, and says when there are none', async () => {
    const seen = editorApi({ 'GET /vendors': () => json(200, page([])) });
    const { user } = renderApp('/orders/new');
    await user.type(await screen.findByRole('combobox', { name: 'Vendor' }), 'Zz');
    expect(await screen.findByText('No active vendor matches.')).toBeVisible();
    const lists = seen.filter(
      (r) => r.method === 'GET' && new URL(r.url).pathname.endsWith('/vendors'),
    );
    expect(lists.length).toBeGreaterThan(0);
    for (const r of lists) expect(new URL(r.url).searchParams.get('status')).toBe('ACTIVE');
  });

  it('[NFR-FE-03] a failed vendor search says so', async () => {
    // Not a retryable code: the search fails at once instead of retrying.
    editorApi({ 'GET /vendors': () => problem(500, 'INTERNAL_ERROR') });
    const { user } = renderApp('/orders/new');
    await user.type(await screen.findByRole('combobox', { name: 'Vendor' }), 'Ac');
    expect(await screen.findByText("Couldn't load vendors. Try again.")).toBeVisible();
  });

  it('[NFR-FE-03] has no automated accessibility violations', async () => {
    editorApi();
    const { user } = renderApp('/orders/new');
    await fillLine(user, 1, { description: 'Washers', quantity: '0', unitPrice: '0.1' });
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('[NFR-AUTH-01] an Admin is told they can view orders but not change them', async () => {
    editorApi({}, ['ADMIN']);
    renderApp('/orders/new');
    expect(await screen.findByText(ORDER_ADMIN_READ_ONLY_MESSAGE)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Create order' })).toBeNull();
  });
});

describe('[FR-PO-01] the order detail', () => {
  it('[FR-PO-07] shows the PO number, status, vendor, owner, lines and exact total in rupees', async () => {
    editorApi({
      [`GET /orders/${ORDER_ID}`]: () =>
        json(200, order({ vendor: { id: ACME_ID, name: 'Acme Supplies', status: 'INACTIVE' } }), {
          ETag: '"1"',
        }),
    });
    renderApp(`/orders/${ORDER_ID}`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'PO-2026-27-000123' }),
    ).toBeVisible();
    expect(screen.getByText('Draft')).toBeVisible();
    expect(screen.getByText('Inactive')).toBeVisible();
    expect(screen.getByText('Bea Buyer')).toBeVisible();
    expect(screen.getByTestId('order-total')).toHaveTextContent('₹0.3875');
    const rows = within(screen.getByRole('table', { name: 'Lines' })).getAllByRole('row');
    expect(rows.slice(1).map((r) => r.textContent)).toEqual([
      'Washers3₹0.10₹0.30',
      'Bolts7₹0.0125₹0.0875',
    ]);
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it("[NFR-FE-03] an order the caller can't read shows not found", async () => {
    editorApi({ [`GET /orders/${ORDER_ID}`]: () => problem(404, 'NOT_FOUND') });
    renderApp(`/orders/${ORDER_ID}`);
    expect(await screen.findByText(errorMessages.NOT_FOUND.message)).toBeVisible();
  });
});
