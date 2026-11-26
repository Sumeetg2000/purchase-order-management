import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axeViolations } from './support/axe';
import { fakeApi, json, ME, problem, type Handler } from './support/fake-api';
import { order, orderLine, ORDER_ID } from './support/orders';
import { renderApp } from './support/render-app';
import { ACME_ID } from './support/vendors';

// The outstanding report's Orders view (specs/008-outstanding-report/contracts/ui.md):
// the as-of line, filters in the address, rows with summary numbers, a row's lines from
// the order's own read on demand, and its states.

afterEach(() => {
  vi.unstubAllGlobals();
});

const row = (extra: Record<string, unknown> = {}) => ({
  id: ORDER_ID,
  poNumber: 'PO-2026-27-000123',
  vendor: { id: ACME_ID, name: 'Acme Supplies', status: 'ACTIVE' },
  owner: { id: '0192e4a0-0000-7000-8000-0000000000a9', name: 'Bea Buyer' },
  createdAt: '2026-09-01T04:30:00.000Z',
  approvedAt: '2026-09-01T06:30:00.000Z',
  approvedOn: '2026-09-01',
  ageDays: 86,
  ageBucket: 'DAYS_61_90',
  lineCount: 5,
  openLineCount: 2,
  outstandingQuantity: 70,
  ...extra,
});

const reportPage = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  items,
  page: 1,
  pageSize: 20,
  total: items.length,
  asOf: '2026-11-26',
  ...extra,
});

function reportApi(handlers: Record<string, Handler> = {}, roles = ['ADMIN']) {
  return fakeApi({
    'GET /me': () => json(200, { ...ME, roles }),
    'GET /reports/outstanding': () => json(200, reportPage([row()])),
    ...handlers,
  });
}

const reportCalls = (seen: Request[]) =>
  seen
    .filter((r) => new URL(r.url).pathname.endsWith('/reports/outstanding'))
    .map((r) => Object.fromEntries(new URL(r.url).searchParams));

const heading = () => screen.findByRole('heading', { level: 1, name: 'Outstanding orders' });

describe('[FR-RPT-01] the outstanding report, Orders view', () => {
  it('[FR-RPT-01] shows the as-of date and each order with its age, band and summary numbers', async () => {
    reportApi();
    renderApp('/reports/outstanding');
    await heading();
    expect(await screen.findByText('Ages as of 26 November 2026 (India time)')).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: /outstanding order/ });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([
      'PO number',
      'Vendor',
      'Owner',
      'Approved',
      'Age',
      'Age band',
      'Open lines',
      'Outstanding',
      'Lines',
    ]);
    const [, first] = within(table).getAllByRole('row');
    expect(
      within(first as HTMLElement).getByRole('link', { name: 'PO-2026-27-000123' }),
    ).toHaveAttribute('href', `/orders/${ORDER_ID}`);
    for (const text of [
      'Acme Supplies',
      'Bea Buyer',
      '1 September 2026',
      '86 days',
      '61–90 days',
      '2 of 5',
      '70',
    ]) {
      expect(first).toHaveTextContent(text);
    }
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('[FR-RPT-01] an inactive vendor is marked, and age 0 reads today', async () => {
    reportApi({
      'GET /reports/outstanding': () =>
        json(
          200,
          reportPage([
            row({
              vendor: { id: ACME_ID, name: 'Acme Supplies', status: 'INACTIVE' },
              ageDays: 0,
              ageBucket: 'DAYS_0_30',
            }),
          ]),
        ),
    });
    renderApp('/reports/outstanding');
    const table = await screen.findByRole('table', { name: /outstanding order/ });
    const [, first] = within(table).getAllByRole('row');
    expect(first).toHaveTextContent('Acme Supplies (inactive)');
    expect(first).toHaveTextContent('today');
  });

  it('[FR-RPT-01] the age band and vendor filters live in the address and reach the API', async () => {
    const seen = reportApi();
    const app = renderApp('/reports/outstanding');
    await heading();
    await app.user.selectOptions(screen.getByLabelText('Age'), 'Over 90 days');
    await waitFor(() => {
      expect(reportCalls(seen).at(-1)).toMatchObject({ ageBucket: 'OVER_90' });
    });
    await app.user.click(await screen.findByRole('link', { name: 'Acme Supplies' }));
    await waitFor(() => {
      expect(reportCalls(seen).at(-1)).toMatchObject({ vendorId: ACME_ID, ageBucket: 'OVER_90' });
    });
    await app.user.click(screen.getByRole('button', { name: 'Show every vendor' }));
    // Back to every vendor, the age band kept (that page may come from the cache).
    await waitFor(() => {
      expect(screen.queryByText(/One vendor/)).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText('Age')).toHaveValue('OVER_90');
  });

  it('[FR-RPT-01] a link with a filter that is not valid asks nothing of the API', async () => {
    const seen = reportApi();
    renderApp('/reports/outstanding?ageBucket=SOON');
    await heading();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "This link has a filter that isn't valid.",
    );
    expect(reportCalls(seen)).toEqual([]);
  });

  it('[FR-RPT-01] empty: nothing outstanding, or nothing matching the filters', async () => {
    reportApi({ 'GET /reports/outstanding': () => json(200, reportPage([])) });
    renderApp('/reports/outstanding');
    expect(await screen.findByText('Nothing is outstanding.')).toBeInTheDocument();
    cleanup();
    reportApi({ 'GET /reports/outstanding': () => json(200, reportPage([])) });
    renderApp('/reports/outstanding?ageBucket=OVER_90');
    expect(
      await screen.findByText('No outstanding orders match these filters.'),
    ).toBeInTheDocument();
  });

  it("[FR-RPT-01] Show lines reads the order and shows each line's ordered, received and outstanding", async () => {
    const seen = reportApi({
      [`GET /orders/${ORDER_ID}`]: () =>
        json(
          200,
          order({
            status: 'APPROVED',
            receiptProgress: 'PARTIALLY_RECEIVED',
            lines: [
              orderLine({
                description: 'Washers',
                quantity: 100,
                receivedQuantity: 40,
                outstandingQuantity: 60,
              }),
              orderLine({
                id: '0192e4a0-0000-7000-8000-0000000000c2',
                position: 1,
                description: 'Bolts',
                quantity: 10,
                receivedQuantity: 10,
                outstandingQuantity: 0,
              }),
            ],
          }),
          { ETag: '"2"' },
        ),
    });
    const app = renderApp('/reports/outstanding');
    const toggle = await screen.findByRole('button', { name: 'Show lines of PO-2026-27-000123' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(seen.some((r) => new URL(r.url).pathname.endsWith(`/orders/${ORDER_ID}`))).toBe(false);
    await app.user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const lines = await screen.findByRole('table', { name: 'Lines of PO-2026-27-000123' });
    expect(
      within(lines)
        .getAllByRole('row')
        .map((r) => r.textContent),
    ).toEqual(['LineDescriptionOrderedReceivedOutstanding', '1Washers1004060', '2Bolts10100']);
    expect(await axeViolations(document.body)).toEqual([]);
    await app.user.click(toggle);
    expect(
      screen.queryByRole('table', { name: 'Lines of PO-2026-27-000123' }),
    ).not.toBeInTheDocument();
  });

  it("[FR-RPT-01] a row's lines that can't be read say so inside the row", async () => {
    // The order can no longer be read (not retried, unlike a 503).
    reportApi({ [`GET /orders/${ORDER_ID}`]: () => problem(404, 'NOT_FOUND') });
    const app = renderApp('/reports/outstanding');
    await app.user.click(
      await screen.findByRole('button', { name: 'Show lines of PO-2026-27-000123' }),
    );
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: /outstanding order/ })).toBeInTheDocument();
  });

  it('[FR-RPT-01] a Buyer reads it as their own orders', async () => {
    reportApi({}, ['BUYER']);
    renderApp('/reports/outstanding');
    await heading();
    expect(screen.getByText('Your orders')).toBeInTheDocument();
  });

  it('[FR-RPT-01] the main navigation offers it to a Buyer, an Approver and an Admin', async () => {
    for (const roles of [['BUYER'], ['APPROVER'], ['ADMIN']]) {
      reportApi(
        {
          'GET /orders': () => json(200, { items: [], page: 1, pageSize: 20, total: 0 }),
          'GET /approvals': () => json(200, { items: [], page: 1, pageSize: 1, total: 0 }),
          'GET /admin/users': () => json(200, { items: [], page: 1, pageSize: 1, total: 0 }),
          'GET /admin/access-requests': () =>
            json(200, { items: [], page: 1, pageSize: 1, total: 0 }),
        },
        roles,
      );
      renderApp('/reports/outstanding');
      const nav = await screen.findByRole('navigation', { name: 'Main' });
      expect(within(nav).getByRole('link', { name: 'Outstanding' }), roles.join()).toHaveAttribute(
        'href',
        '/reports/outstanding',
      );
      cleanup();
    }
  });
});
