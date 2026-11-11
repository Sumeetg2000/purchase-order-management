import { API_PATH_PREFIX } from '@po/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorMessages } from '../src/errors/messages';
import { axeViolations } from './support/axe';
import { fakeApi, json, ME, problem, type Handler } from './support/fake-api';
import { renderApp } from './support/render-app';
import { ACME_ID as ACME, page, vendor } from './support/vendors';

// The vendor list and detail (specs/003-vendors/contracts/ui.md; spec US1): the table,
// the payment-terms wording, filters in the URL, pagination and the page states.

afterEach(() => {
  vi.unstubAllGlobals();
});

const THREE = [
  vendor(),
  vendor({
    id: '0192e4a0-0000-7000-8000-0000000000a2',
    name: 'Advance Co',
    paymentTerms: { type: 'ADVANCE' },
  }),
  vendor({
    id: '0192e4a0-0000-7000-8000-0000000000a3',
    name: 'Partial Co',
    contactName: 'Mei Lin',
    contactEmail: 'mei@partial.example',
    paymentTerms: { type: 'PARTIAL_ADVANCE', advancePercent: 30, netDays: 45 },
  }),
];

function vendorApi(roles: readonly string[] = ['BUYER'], handlers: Record<string, Handler> = {}) {
  return fakeApi({
    'GET /me': () => json(200, { ...ME, roles }),
    'GET /vendors': () => json(200, page(THREE)),
    ...handlers,
  });
}

const listRequests = (seen: Request[]) =>
  seen.filter((r) => new URL(r.url).pathname === `${API_PATH_PREFIX}/vendors`);

const rowOf = async (name: string) =>
  (await screen.findByRole('link', { name })).closest('tr') as HTMLElement;

describe('[FR-VEN-01] vendor list', () => {
  it('[FR-VEN-01] shows each vendor with its contact, payment terms and status', async () => {
    vendorApi();
    renderApp('/vendors');
    const acme = await rowOf('Acme Supplies');
    expect(within(acme).getByRole('link', { name: 'Acme Supplies' })).toHaveAttribute(
      'href',
      `/vendors/${ACME}`,
    );
    expect(within(acme).getByText('Ravi Shah')).toBeInTheDocument();
    expect(within(acme).getByText('ravi@acme.example')).toBeInTheDocument();
    expect(within(acme).getByRole('cell', { name: 'Net 30' })).toBeInTheDocument();
    expect(within(acme).getByRole('cell', { name: 'Active' })).toBeInTheDocument();
    expect(
      within(await rowOf('Advance Co')).getByRole('cell', { name: 'Advance' }),
    ).toBeInTheDocument();
    expect(
      within(await rowOf('Partial Co')).getByRole('cell', {
        name: '30 % advance, balance net 45',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('3 vendors')).toBeInTheDocument();
  });

  it('[FR-VEN-01] active is the default filter, and the URL carries the filters and page', async () => {
    const seen = vendorApi();
    const { user, router } = renderApp('/vendors?status=ALL&q=acm&page=2');
    expect(await screen.findByLabelText('Status')).toHaveValue('ALL');
    expect(screen.getByLabelText('Name starts with')).toHaveValue('acm');
    await waitFor(() => {
      expect(new URL(listRequests(seen).at(-1)?.url ?? '').search).toBe('?status=ALL&q=acm&page=2');
    });
    await user.selectOptions(screen.getByLabelText('Status'), 'ACTIVE');
    expect(router.state.location.search).toBe('?q=acm');
    expect(screen.getByLabelText('Status')).toHaveValue('ACTIVE');
    await user.selectOptions(screen.getByLabelText('Status'), 'INACTIVE');
    expect(router.state.location.search).toBe('?status=INACTIVE&q=acm');
  });

  it('[FR-VEN-01] the name search updates the URL as the user types, from page 1', async () => {
    vendorApi();
    const { user, router } = renderApp('/vendors?page=3');
    await user.type(await screen.findByLabelText('Name starts with'), 'Acme S');
    await waitFor(() => {
      expect(router.state.location.search).toBe('?q=Acme+S');
    });
    expect(screen.getByLabelText('Name starts with')).toHaveValue('Acme S');
    expect(screen.getByLabelText('Name starts with')).toHaveFocus();
  });

  it('[FR-VEN-01] pages through the list', async () => {
    vendorApi(['BUYER'], { 'GET /vendors': () => json(200, page(THREE, { total: 45 })) });
    const { user, router } = renderApp('/vendors');
    expect(await screen.findByText('Page 1 of 3')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(router.state.location.search).toBe('?page=2');
  });

  it.each([
    ['', 'No active vendors'],
    ['?status=INACTIVE', 'No inactive vendors'],
    ['?status=ALL', 'No vendors'],
  ])('[FR-VEN-01] the empty state names the filter (%s)', async (search, title) => {
    vendorApi(['BUYER'], { 'GET /vendors': () => json(200, page([])) });
    renderApp(`/vendors${search}`);
    expect(await screen.findByRole('heading', { level: 2, name: title })).toBeInTheDocument();
  });

  it('[FR-VEN-01] a search with no match says so', async () => {
    vendorApi(['BUYER'], { 'GET /vendors': () => json(200, page([])) });
    renderApp('/vendors?q=zz');
    expect(await screen.findByText('No active vendor name starts with “zz”.')).toBeInTheDocument();
  });

  it('[FR-VEN-01] a failed load shows the error', async () => {
    vendorApi(['BUYER'], { 'GET /vendors': () => problem(500, 'INTERNAL_ERROR') });
    renderApp('/vendors');
    expect(
      await screen.findByText(errorMessages.INTERNAL_ERROR.message, { exact: false }),
    ).toBeInTheDocument();
  });

  it('[FR-VEN-01] Buyers get an Add vendor link; Approvers and Admins do not', async () => {
    vendorApi(['BUYER']);
    renderApp('/vendors');
    expect(await screen.findByRole('link', { name: 'Add vendor' })).toHaveAttribute(
      'href',
      '/vendors/new',
    );
  });

  it.each([['APPROVER'], ['ADMIN']])('[FR-VEN-01] %s sees no Add vendor link', async (role) => {
    vendorApi([role]);
    renderApp('/vendors');
    await rowOf('Acme Supplies');
    expect(screen.queryByRole('link', { name: 'Add vendor' })).toBeNull();
  });

  it('[SC-007] the list has no axe violations', async () => {
    vendorApi();
    renderApp('/vendors');
    await rowOf('Acme Supplies');
    expect(await axeViolations(document.body)).toEqual([]);
  });
});

describe('[FR-VEN-01] vendor detail', () => {
  it('[FR-VEN-01] shows the vendor, its status and payment terms, to every role', async () => {
    vendorApi(['APPROVER'], {
      [`GET /vendors/${ACME}`]: () =>
        json(200, vendor({ contactPhone: '022 4000 1000' }), { ETag: '"1"' }),
    });
    renderApp(`/vendors/${ACME}`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Acme Supplies' }),
    ).toBeInTheDocument();
    const details = screen.getByRole('list', { name: 'Vendor details' });
    expect(within(details).getByText('Ravi Shah')).toBeInTheDocument();
    expect(within(details).getByText('ravi@acme.example')).toBeInTheDocument();
    expect(within(details).getByText('022 4000 1000')).toBeInTheDocument();
    expect(within(details).getByText('Net 30')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('[FR-VEN-01] a vendor with no phone says so', async () => {
    vendorApi(['BUYER'], { [`GET /vendors/${ACME}`]: () => json(200, vendor()) });
    renderApp(`/vendors/${ACME}`);
    const details = await screen.findByRole('list', { name: 'Vendor details' });
    expect(within(details).getByText('None')).toBeInTheDocument();
  });

  it('[FR-VEN-01] an unknown vendor shows the not-found message', async () => {
    vendorApi(['BUYER'], { [`GET /vendors/${ACME}`]: () => problem(404, 'NOT_FOUND') });
    renderApp(`/vendors/${ACME}`);
    expect(
      await screen.findByText(errorMessages.NOT_FOUND.message, { exact: false }),
    ).toBeInTheDocument();
  });
});
