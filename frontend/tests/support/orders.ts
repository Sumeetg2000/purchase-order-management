import { ACME_ID } from './vendors';

// Order fixtures for component tests, shaped as the API returns them.

export const ORDER_ID = '0192e4a0-0000-7000-8000-0000000000b1';
const BUYER_ID = '0192e4a0-7b1c-7cc0-8a4e-1f2b3c4d5e6f';

export const orderLine = (extra: Record<string, unknown> = {}) => ({
  id: '0192e4a0-0000-7000-8000-0000000000c1',
  description: 'Washers',
  quantity: 3,
  unitPrice: '0.1000',
  lineTotal: '0.3000',
  ...extra,
});

export const order = (extra: Record<string, unknown> = {}) => ({
  id: ORDER_ID,
  poNumber: 'PO-2026-27-000123',
  status: 'DRAFT',
  vendor: { id: ACME_ID, name: 'Acme Supplies', status: 'ACTIVE' },
  owner: { id: BUYER_ID, name: 'Bea Buyer' },
  total: '0.3875',
  lineCount: 2,
  lines: [
    orderLine(),
    orderLine({
      id: '0192e4a0-0000-7000-8000-0000000000c2',
      description: 'Bolts',
      quantity: 7,
      unitPrice: '0.0125',
      lineTotal: '0.0875',
    }),
  ],
  version: 1,
  createdAt: '2026-11-12T09:00:00.000Z',
  updatedAt: '2026-11-12T09:00:00.000Z',
  ...extra,
});
