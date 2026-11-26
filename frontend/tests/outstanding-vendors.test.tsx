import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axeViolations } from './support/axe';
import { fakeApi, json, ME, type Handler } from './support/fake-api';
import { renderApp } from './support/render-app';
import { ACME_ID } from './support/vendors';

// The outstanding report's By vendor view (specs/008-outstanding-report/contracts/ui.md):
// per vendor, the orders, the count per age band and the oldest approval; each vendor
// links to the Orders view filtered to it.

afterEach(() => {
  vi.unstubAllGlobals();
});

const vendorRow = (extra: Record<string, unknown> = {}) => ({
  vendor: { id: ACME_ID, name: 'Acme Supplies', status: 'ACTIVE' },
  orderCount: 4,
  byBucket: { DAYS_0_30: 1, DAYS_31_60: 0, DAYS_61_90: 2, OVER_90: 1 },
  oldestApprovedOn: '2026-07-01',
  ...extra,
});

function vendorsApi(handlers: Record<string, Handler> = {}) {
  return fakeApi({
    'GET /me': () => json(200, { ...ME, roles: ['ADMIN'] }),
    'GET /reports/outstanding/vendors': () =>
      json(200, { items: [vendorRow()], page: 1, pageSize: 20, total: 1, asOf: '2026-11-26' }),
    'GET /reports/outstanding': () =>
      json(200, { items: [], page: 1, pageSize: 20, total: 0, asOf: '2026-11-26' }),
    ...handlers,
  });
}

describe('[FR-RPT-01] the outstanding report, By vendor view', () => {
  it('[FR-RPT-01] shows each vendor with its orders per age band and oldest approval', async () => {
    vendorsApi();
    renderApp('/reports/outstanding/vendors');
    await screen.findByRole('heading', { level: 1, name: 'Outstanding orders' });
    expect(await screen.findByText('Ages as of 26 November 2026 (India time)')).toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Report views' });
    expect(within(tabs).getByRole('link', { name: 'By vendor' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const table = screen.getByRole('table', { name: /vendor/ });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([
      'Vendor',
      'Orders',
      '0–30 days',
      '31–60 days',
      '61–90 days',
      'Over 90 days',
      'Oldest approval',
    ]);
    const [, first] = within(table).getAllByRole('row');
    expect(
      [...within(first as HTMLElement).getAllByRole('cell')].map((c) => c.textContent),
    ).toEqual(['Acme Supplies', '4', '1', '0', '2', '1', '1 July 2026']);
    expect(
      within(first as HTMLElement).getByRole('link', { name: 'Acme Supplies' }),
    ).toHaveAttribute('href', `/reports/outstanding?vendorId=${ACME_ID}`);
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('[FR-RPT-01] an inactive vendor is marked', async () => {
    vendorsApi({
      'GET /reports/outstanding/vendors': () =>
        json(200, {
          items: [
            vendorRow({ vendor: { id: ACME_ID, name: 'Acme Supplies', status: 'INACTIVE' } }),
          ],
          page: 1,
          pageSize: 20,
          total: 1,
          asOf: '2026-11-26',
        }),
    });
    renderApp('/reports/outstanding/vendors');
    const table = await screen.findByRole('table', { name: /vendor/ });
    const [, first] = within(table).getAllByRole('row');
    expect(first).toHaveTextContent('Acme Supplies (inactive)');
  });

  it('[FR-RPT-01] nothing outstanding says so', async () => {
    vendorsApi({
      'GET /reports/outstanding/vendors': () =>
        json(200, { items: [], page: 1, pageSize: 20, total: 0, asOf: '2026-11-26' }),
    });
    renderApp('/reports/outstanding/vendors');
    expect(await screen.findByText('Nothing is outstanding.')).toBeInTheDocument();
  });

  it('[FR-RPT-01] following a vendor opens the Orders view filtered to it', async () => {
    const seen = vendorsApi();
    const app = renderApp('/reports/outstanding/vendors');
    await app.user.click(await screen.findByRole('link', { name: 'Acme Supplies' }));
    await screen.findByText(/One vendor/);
    const calls = seen
      .filter((r) => new URL(r.url).pathname.endsWith('/reports/outstanding'))
      .map((r) => new URL(r.url).searchParams.get('vendorId'));
    expect(calls).toEqual([ACME_ID]);
  });
});
