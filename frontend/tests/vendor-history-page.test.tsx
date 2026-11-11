import { API_PATH_PREFIX } from '@po/contracts';
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorMessages } from '../src/errors/messages';
import { formatDateTime } from '../src/format/date';
import { axeViolations } from './support/axe';
import { fakeApi, json, ME, problem, type Handler } from './support/fake-api';
import { renderApp } from './support/render-app';
import { ACME_ID, page, vendor } from './support/vendors';

// A vendor's history (specs/003-vendors/contracts/ui.md; spec US5): a tab beside Details
// for Buyers and Admins, newest first and paged, each entry with when, who, the action
// and the changed fields before → after. Approvers have no tab and get the 403 page.

afterEach(() => {
  vi.unstubAllGlobals();
});

const HISTORY = `GET /vendors/${ACME_ID}/history`;
const ACME = {
  name: 'Acme Supplies',
  contactName: 'Ravi Shah',
  contactEmail: 'ravi@acme.example',
  contactPhone: null,
  paymentTerms: { type: 'NET', netDays: 30 },
  status: 'ACTIVE',
};
const BEA = { type: 'USER', name: 'Bea Buyer', email: 'bea@example.local', role: 'BUYER' };

const entry = (id: string, action: string, before: unknown, after: unknown, extra = {}) => ({
  id,
  action,
  occurredAt: `2026-11-1${id}T09:00:00.000Z`,
  actor: BEA,
  before,
  after,
  ...extra,
});

const FOUR = [
  entry('4', 'VENDOR_REACTIVATED', { ...ACME, status: 'INACTIVE' }, ACME),
  entry('3', 'VENDOR_DEACTIVATED', ACME, { ...ACME, status: 'INACTIVE' }),
  entry('2', 'VENDOR_UPDATED', { ...ACME, name: 'Acme Co' }, ACME, {
    actor: { type: 'SYSTEM', name: null, email: null, role: null },
  }),
  entry('1', 'VENDOR_CREATED', null, { ...ACME, name: 'Acme Co' }),
];

function historyApi(roles: readonly string[], handlers: Record<string, Handler> = {}) {
  return fakeApi({
    'GET /me': () => json(200, { ...ME, roles }),
    [`GET /vendors/${ACME_ID}`]: () => json(200, vendor(), { ETag: '"1"' }),
    [HISTORY]: () => json(200, page(FOUR)),
    ...handlers,
  });
}

/** The element at `index`, failing the test when there is none. */
function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item ${String(index)}`);
  return item;
}

/** The history's entries: the list's own items, not the changes listed inside each. */
const entries = async () =>
  Array.from((await screen.findByRole('list', { name: 'Vendor history' })).children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement,
  );

describe('[NFR-AUD-03] vendor history tab', () => {
  it.each([['BUYER'], ['ADMIN']])('[NFR-AUD-03] %s has Details and History tabs', async (role) => {
    historyApi([role]);
    renderApp(`/vendors/${ACME_ID}`);
    const tabs = await screen.findByRole('navigation', { name: 'Vendor sections' });
    expect(within(tabs).getByRole('link', { name: 'Details' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(tabs).getByRole('link', { name: 'History' })).toHaveAttribute(
      'href',
      `/vendors/${ACME_ID}/history`,
    );
  });

  it('[NFR-AUD-03] an Approver has no History tab', async () => {
    historyApi(['APPROVER']);
    renderApp(`/vendors/${ACME_ID}`);
    await screen.findByRole('heading', { level: 1, name: 'Acme Supplies' });
    expect(screen.queryByRole('link', { name: 'History' })).toBeNull();
  });

  it('[NFR-AUD-03] the history URL shows an Approver the 403 page', async () => {
    historyApi(['APPROVER']);
    renderApp(`/vendors/${ACME_ID}/history`);
    expect(
      await screen.findByRole('heading', { level: 1, name: "You don't have access to this page" }),
    ).toBeVisible();
  });

  it('[NFR-AUD-03] lists entries newest first with when, who and the action', async () => {
    historyApi(['BUYER']);
    renderApp(`/vendors/${ACME_ID}/history`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Acme Supplies' }),
    ).toBeInTheDocument();
    const items = await entries();
    expect(items.map((item) => within(item).getByRole('heading').textContent)).toEqual([
      'Reactivated',
      'Deactivated',
      'Edited',
      'Created',
    ]);
    const newest = nth(items, 0);
    expect(newest).toHaveTextContent('Bea Buyer (bea@example.local, Buyer)');
    expect(nth(items, 2)).toHaveTextContent('System');
    expect(within(newest).getByText(formatDateTime('2026-11-14T09:00:00.000Z'))).toHaveAttribute(
      'dateTime',
      '2026-11-14T09:00:00.000Z',
    );
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('[NFR-AUD-03] shows only the changed fields, before → after; a create shows the values', async () => {
    historyApi(['ADMIN']);
    renderApp(`/vendors/${ACME_ID}/history`);
    const items = await entries();
    const changes = (index: number) =>
      within(within(nth(items, index)).getByRole('list', { name: 'Changes' }))
        .getAllByRole('listitem')
        .map((change) => change.textContent);

    expect(changes(0)).toEqual(['Status: Inactive → Active']);
    expect(changes(1)).toEqual(['Status: Active → Inactive']);
    expect(changes(2)).toEqual(['Name: Acme Co → Acme Supplies']);
    expect(changes(3)).toEqual([
      'Name: Acme Co',
      'Contact: Ravi Shah',
      'Email: ravi@acme.example',
      'Phone: None',
      'Payment terms: Net 30',
      'Status: Active',
    ]);
  });

  it('[NFR-AUD-03] pages through the history, the page in the URL', async () => {
    const seen = historyApi(['BUYER'], {
      [HISTORY]: (request) => {
        const p = Number(new URL(request.url).searchParams.get('page') ?? '1');
        return json(
          200,
          page(p === 1 ? FOUR.slice(0, 2) : FOUR.slice(2), { page: p, pageSize: 2, total: 4 }),
        );
      },
    });
    const { user } = renderApp(`/vendors/${ACME_ID}/history`);
    expect(await entries()).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('Page 2 of 2')).toBeInTheDocument();
    const last = seen
      .filter((r) => new URL(r.url).pathname === `${API_PATH_PREFIX}/vendors/${ACME_ID}/history`)
      .at(-1);
    expect(new URL(last?.url ?? '').searchParams.get('page')).toBe('2');
    expect(nth(await entries(), 1)).toHaveTextContent('Created');
  });

  it('[NFR-AUD-03] says when there is no history yet', async () => {
    historyApi(['BUYER'], { [HISTORY]: () => json(200, page([])) });
    renderApp(`/vendors/${ACME_ID}/history`);
    expect(await screen.findByText('No history yet')).toBeInTheDocument();
  });

  it('[NFR-AUD-03] shows a failed load', async () => {
    historyApi(['BUYER'], { [HISTORY]: () => problem(500, 'INTERNAL_ERROR') });
    renderApp(`/vendors/${ACME_ID}/history`);
    expect(
      await screen.findByText(errorMessages.INTERNAL_ERROR.message, { exact: false }),
    ).toBeInTheDocument();
  });
});
