// Vendor fixtures for component tests, shaped as the API returns them.

export const ACME_ID = '0192e4a0-0000-7000-8000-0000000000a1';

export const vendor = (extra: Record<string, unknown> = {}) => ({
  id: ACME_ID,
  name: 'Acme Supplies',
  contactName: 'Ravi Shah',
  contactEmail: 'ravi@acme.example',
  contactPhone: null,
  paymentTerms: { type: 'NET', netDays: 30 },
  status: 'ACTIVE',
  deactivatedAt: null,
  version: 1,
  createdAt: '2026-11-01T09:00:00.000Z',
  updatedAt: '2026-11-01T09:00:00.000Z',
  ...extra,
});

export const page = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  items,
  page: 1,
  pageSize: 20,
  total: items.length,
  ...extra,
});
