import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorMessages } from '../src/errors/messages';
import { axeViolations } from './support/axe';
import { fakeApi, json, ME, problem, type Handler } from './support/fake-api';
import { order, ORDER_ID } from './support/orders';
import { renderApp } from './support/render-app';
import { ACME_ID, page, vendor } from './support/vendors';

// The orders list (contracts/ui.md; spec US5): filters and page in the URL, the PO-number
// search debounced, totals in rupees, and the states of an empty or failed list.

afterEach(() => {
  vi.unstubAllGlobals();
});

const item = (extra: Record<string, unknown> = {}) => {
  const rest = Object.fromEntries(
    Object.entries(order()).filter(([key]) => !['lines', 'version', 'updatedAt'].includes(key)),
  );
  return { ...rest, vendor: { id: ACME_ID, name: 'Acme Supplies' }, ...extra };
};

function listApi(handlers: Record<string, Handler> = {}, roles = ['BUYER']) {
  return fakeApi({
    'GET /me': () => json(200, { ...ME, roles }),
    'GET /orders': () => json(200, page([item()])),
    'GET /vendors': () => json(200, page([vendor()])),
    ...handlers,
  });
}

const listCalls = (seen: Request[]) =>
  seen
    .filter((r) => r.method === 'GET' && new URL(r.url).pathname.endsWith('/orders'))
    .map((r) => Object.fromEntries(new URL(r.url).searchParams));

describe('[FR-PO-01] the orders list', () => {
  it('[NFR-FE-03] shows each order with its PO number, vendor, status, lines, total in rupees and date', async () => {
    listApi();
    renderApp('/orders');
    expect(await screen.findByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
    const rows = within(await screen.findByRole('table')).getAllByRole('row');
    expect(
      within(rows[1] as HTMLElement).getByRole('link', { name: 'PO-2026-27-000123' }),
    ).toHaveAttribute('href', `/orders/${ORDER_ID}`);
    expect(rows[1]).toHaveTextContent('Acme Supplies');
    expect(rows[1]).toHaveTextContent('Draft');
    expect(rows[1]).toHaveTextContent('₹0.3875');
    expect(screen.getByRole('link', { name: 'New order' })).toHaveAttribute('href', '/orders/new');
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('[NFR-FE-04] filters and the page live in the URL and are sent to the API', async () => {
    const seen = listApi();
    const { router } = renderApp(
      `/orders?status=DRAFT&vendorId=${ACME_ID}&poNumber=PO-2026&createdFrom=2026-04-01&createdTo=2026-04-30&page=2`,
    );
    await screen.findByRole('table');
    expect(listCalls(seen).at(-1)).toEqual({
      status: 'DRAFT',
      vendorId: ACME_ID,
      poNumber: 'PO-2026',
      createdFrom: '2026-04-01',
      createdTo: '2026-04-30',
      page: '2',
    });
    expect(screen.getByLabelText('Status')).toHaveValue('DRAFT');
    expect(screen.getByLabelText('PO number starts with')).toHaveValue('PO-2026');
    expect(screen.getByLabelText('Created from')).toHaveValue('2026-04-01');
    expect(screen.getByText('Sorted by PO number, newest first.')).toBeVisible();
    await router.navigate('/orders?status=APPROVED');
    await waitFor(() => {
      expect(listCalls(seen).at(-1)).toEqual({ status: 'APPROVED' });
    });
    await router.navigate(-1);
    await waitFor(() => {
      expect(screen.getByLabelText('Status')).toHaveValue('DRAFT');
    });
  });

  it('[NFR-FE-04] changing a filter writes it to the URL and starts from page 1', async () => {
    listApi();
    const { user, router } = renderApp('/orders?page=3');
    await user.selectOptions(await screen.findByLabelText('Status'), 'DRAFT');
    expect(router.state.location.search).toBe('?status=DRAFT');
    await user.type(screen.getByLabelText('Created to'), '2026-05-31');
    await waitFor(() => {
      expect(router.state.location.search).toBe('?status=DRAFT&createdTo=2026-05-31');
    });
  });

  it('[NFR-FE-04] the PO-number search sends one request once typing stops', async () => {
    const seen = listApi();
    const { user, router } = renderApp('/orders');
    await screen.findByRole('table');
    const before = listCalls(seen).length;
    await user.type(screen.getByLabelText('PO number starts with'), 'po-2026-27-00');
    await waitFor(() => {
      expect(router.state.location.search).toBe('?poNumber=po-2026-27-00');
    });
    await waitFor(() => {
      expect(listCalls(seen).length).toBe(before + 1);
    });
    expect(listCalls(seen).at(-1)).toEqual({ poNumber: 'po-2026-27-00' });
  });

  it('[NFR-FE-03] a Buyer with no orders is told how to raise one; a failure says so', async () => {
    listApi({ 'GET /orders': () => json(200, page([])) });
    renderApp('/orders');
    expect(await screen.findByText('No orders yet')).toBeVisible();
    vi.unstubAllGlobals();
    listApi({ 'GET /orders': () => problem(500, 'INTERNAL_ERROR') });
    renderApp('/orders');
    expect(await screen.findByText(errorMessages.INTERNAL_ERROR.message)).toBeVisible();
  });
});

describe('[FR-OWN-01] the orders list by role', () => {
  it('[FR-OWN-01] an Approver sees why the list is empty, and no New order', async () => {
    listApi({ 'GET /orders': () => json(200, page([])) }, ['APPROVER']);
    renderApp('/orders');
    expect(await screen.findByText('Orders appear here once buyers submit them.')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'New order' })).toBeNull();
  });

  it('[FR-OWN-01] an Admin lists every order read-only: no New order, no Edit', async () => {
    listApi({ [`GET /orders/${ORDER_ID}`]: () => json(200, order(), { ETag: '"1"' }) }, ['ADMIN']);
    const { user } = renderApp('/orders');
    await screen.findByRole('table');
    expect(screen.queryByRole('link', { name: 'New order' })).toBeNull();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Orders' })).toBeVisible();
    await user.click(screen.getByRole('link', { name: 'PO-2026-27-000123' }));
    await screen.findByRole('heading', { level: 1, name: 'PO-2026-27-000123' });
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
  });
});
