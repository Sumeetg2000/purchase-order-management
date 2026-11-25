import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axeViolations } from './support/axe';
import { fakeApi, json, ME, problem } from './support/fake-api';
import { approvedOrder, order, orderLine, ORDER_ID } from './support/orders';
import { renderApp } from './support/render-app';
import { page } from './support/vendors';

// The order page's receipts (contracts/ui.md; spec FR-005, FR-021): received and
// outstanding per line on a non-draft order, the progress badge by the status, and the
// Receipts section: summaries newest first, each expanding to load its lines.

afterEach(() => {
  vi.unstubAllGlobals();
});

const RECEIPT_ID = '0192e4a0-0000-7000-8000-0000000000d1';
const BUYER = { ...ME, id: order().owner.id, roles: ['BUYER'] };

/** The approved order with its first line 40 of 100 received. */
const partlyReceived = () =>
  approvedOrder({
    lines: [
      orderLine({ quantity: 100, receivedQuantity: 40 }),
      orderLine({ id: '0192e4a0-0000-7000-8000-0000000000c2', description: 'Bolts', quantity: 7 }),
    ],
    receiptProgress: 'PARTIALLY_RECEIVED',
    receivedLines: { complete: 0, partly: 1, total: 2 },
  });

const summary = {
  id: RECEIPT_ID,
  receivedOn: '2026-11-24',
  recordedAt: '2026-11-25T04:00:00.000Z',
  recordedBy: { id: BUYER.id, name: 'Bea Buyer' },
  note: 'First van',
  lineCount: 1,
};

const detail = {
  id: summary.id,
  receivedOn: summary.receivedOn,
  recordedAt: summary.recordedAt,
  recordedBy: summary.recordedBy,
  note: summary.note,
  lines: [
    {
      line: { id: '0192e4a0-0000-7000-8000-0000000000c1', position: 0, description: 'Washers' },
      quantity: 40,
    },
  ],
};

function show(shown: Record<string, unknown>, extra: Record<string, () => Response> = {}) {
  const seen = fakeApi({
    'GET /me': () => json(200, BUYER),
    [`GET /orders/${ORDER_ID}`]: () => json(200, shown, { ETag: '"3"' }),
    [`GET /orders/${ORDER_ID}/receipts`]: () => json(200, page([summary])),
    [`GET /orders/${ORDER_ID}/receipts/${RECEIPT_ID}`]: () => json(200, detail),
    ...extra,
  });
  const app = renderApp(`/orders/${ORDER_ID}`);
  return { ...app, seen };
}

const heading = () => screen.findByRole('heading', { level: 1, name: 'PO-2026-27-000123' });

describe('[FR-RCV-01] received and outstanding on the order page', () => {
  it('[FR-RCV-01] a non-draft order shows Received and Outstanding per line, and the progress badge', async () => {
    show(partlyReceived());
    await heading();
    const table = screen.getByRole('table', { name: 'Lines' });
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual([
      'Description',
      'Quantity',
      'Unit price',
      'Line total',
      'Received',
      'Outstanding',
    ]);
    const [, first] = within(table).getAllByRole('row');
    expect(first).toHaveTextContent('40');
    expect(first).toHaveTextContent('60');
    expect(screen.getByText('Partly received')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 lines partly received')).toBeInTheDocument();
  });

  it('[FR-RCV-01] a draft shows no Received or Outstanding columns and no Receipts section', async () => {
    show(order());
    await heading();
    const headers = within(screen.getByRole('table', { name: 'Lines' }))
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).not.toContain('Received');
    expect(screen.queryByRole('region', { name: 'Receipts' })).not.toBeInTheDocument();
  });

  it('[FR-RCV-01] a fully received order says so beside its status', async () => {
    show(
      approvedOrder({
        lines: [orderLine({ receivedQuantity: 3 })],
        receiptProgress: 'FULLY_RECEIVED',
        receivedLines: { complete: 1, partly: 0, total: 1 },
      }),
    );
    await heading();
    expect(screen.getByText('Fully received')).toBeInTheDocument();
  });
});

describe('[FR-RCV-03] the Receipts section', () => {
  it('[FR-RCV-03] an approved order with nothing received says so, without asking the server', async () => {
    const { seen } = show(approvedOrder());
    await heading();
    const section = screen.getByRole('region', { name: 'Receipts' });
    expect(section).toHaveTextContent('No goods received yet.');
    expect(seen.some((r) => new URL(r.url).pathname.endsWith('/receipts'))).toBe(false);
  });

  it('[FR-RCV-03] lists each receipt; expanding one loads its lines, numbered from 1', async () => {
    const { user, seen } = show(partlyReceived());
    const section = await screen.findByRole('region', { name: 'Receipts' });
    const item = await within(section).findByRole('listitem');
    expect(item).toHaveTextContent('24 November 2026');
    expect(item).toHaveTextContent('Bea Buyer');
    expect(item).toHaveTextContent('1 line');
    expect(item).toHaveTextContent('First van');
    const toggle = within(item).getByRole('button', { name: /Show lines/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(seen.some((r) => new URL(r.url).pathname.endsWith(RECEIPT_ID))).toBe(false);
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const lines = await within(item).findByRole('table', { name: 'Receipt lines' });
    expect(lines).toHaveTextContent('Line 1');
    expect(lines).toHaveTextContent('Washers');
    expect(lines).toHaveTextContent('40');
    expect(lines).not.toHaveTextContent(/line 0\b/i);
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('[FR-RCV-03] a receipt whose lines fail to load says so inside it', async () => {
    const { user } = show(partlyReceived(), {
      [`GET /orders/${ORDER_ID}/receipts/${RECEIPT_ID}`]: () => problem(500, 'INTERNAL_ERROR'),
    });
    const section = await screen.findByRole('region', { name: 'Receipts' });
    const item = await within(section).findByRole('listitem');
    await user.click(within(item).getByRole('button', { name: /Show lines/ }));
    expect(await within(item).findByRole('alert')).toHaveTextContent(
      'Something went wrong on our side.',
    );
  });
});
