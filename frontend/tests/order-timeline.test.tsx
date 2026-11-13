import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axeViolations } from './support/axe';
import { fakeApi, json, ME } from './support/fake-api';
import { order, ORDER_ID } from './support/orders';
import { renderApp } from './support/render-app';
import { page } from './support/vendors';

// An order's timeline tab (contracts/ui.md; FR-018): its entries newest first, each with
// what happened, who did it in what capacity, when, and the total it left.

afterEach(() => {
  vi.unstubAllGlobals();
});

const entry = (action: string, details: Record<string, unknown>, id: string) => ({
  id,
  action,
  occurredAt: '2026-11-12T09:30:00.000Z',
  actor: { type: 'USER', name: 'Bea Buyer', email: 'bea@example.local', role: 'BUYER' },
  details,
});

describe('[NFR-AUD-03] the order timeline', () => {
  it('[NFR-AUD-03] lists the entries newest first with who, in what capacity, when and the total', async () => {
    const seen = fakeApi({
      'GET /me': () => json(200, { ...ME, roles: ['BUYER'] }),
      [`GET /orders/${ORDER_ID}`]: () => json(200, order(), { ETag: '"1"' }),
      [`GET /orders/${ORDER_ID}/timeline`]: () =>
        json(
          200,
          page([
            entry('PO_EDITED', { total: { before: '0.3000', after: '0.3875' }, lines: {} }, '2'),
            entry('PO_CREATED', { total: '0.3000' }, '1'),
          ]),
        ),
    });
    const { user } = renderApp(`/orders/${ORDER_ID}`);
    await user.click(await screen.findByRole('link', { name: 'Timeline' }));
    const list = await screen.findByRole('list', { name: 'Order timeline' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Edited');
    expect(items[0]).toHaveTextContent('Bea Buyer (bea@example.local, Buyer)');
    expect(items[0]).toHaveTextContent('Total: ₹0.30 → ₹0.3875');
    expect(items[1]).toHaveTextContent('Raised');
    expect(items[1]).toHaveTextContent('Total: ₹0.30');
    expect(seen.some((r) => new URL(r.url).pathname.endsWith('/timeline'))).toBe(true);
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
