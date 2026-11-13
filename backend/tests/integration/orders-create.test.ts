import { API_PATH_PREFIX, PO_NUMBER_PATTERN } from '@po/contracts';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { lineBody, ordersHarness } from '../support/orders.js';

// Raising a draft (spec US1; FR-001, FR-003, FR-006, FR-008; research R2, R5, R9): the
// stored order, exact totals, the vendor check, strict validation and idempotent retries.

const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';

describe('[FR-PO-01] raise a draft order', () => {
  it('[FR-PO-01] a Buyer creates a draft: 201 with Location, ETag "1", the PO number and exact totals', async () => {
    const h = await ordersHarness();
    const res = await h.createOrder(
      h.orderBody([
        lineBody({ description: '  Washers  ', quantity: 3, unitPrice: '0.1' }),
        lineBody({ description: 'Bolts', quantity: 7, unitPrice: '0.0125' }),
        lineBody({ description: 'Free sample', quantity: 1, unitPrice: '0' }),
      ]),
    );
    expect(res.status).toBe(201);
    const order = res.body as { id: string; poNumber: string; lines: { id: string }[] };
    expect(res.get('ETag')).toBe('"1"');
    expect(res.get('Location')).toBe(`${API_PATH_PREFIX}/orders/${order.id}`);
    expect(order.poNumber).toMatch(PO_NUMBER_PATTERN);
    expect(res.body).toEqual({
      id: expect.any(String) as unknown,
      poNumber: order.poNumber,
      status: 'DRAFT',
      vendor: { id: h.vendorId, name: 'Acme Supplies', status: 'ACTIVE' },
      owner: { id: h.buyer.id, name: 'Bea Buyer' },
      total: '0.3875',
      lineCount: 3,
      lines: [
        {
          id: expect.any(String) as unknown,
          description: 'Washers',
          quantity: 3,
          unitPrice: '0.1000',
          lineTotal: '0.3000',
        },
        {
          id: expect.any(String) as unknown,
          description: 'Bolts',
          quantity: 7,
          unitPrice: '0.0125',
          lineTotal: '0.0875',
        },
        {
          id: expect.any(String) as unknown,
          description: 'Free sample',
          quantity: 1,
          unitPrice: '0.0000',
          lineTotal: '0.0000',
        },
      ],
      version: 1,
      createdAt: expect.any(String) as unknown,
      updatedAt: expect.any(String) as unknown,
    });

    const read = await h.getOrder(order.id);
    expect(read.status).toBe(200);
    expect(read.get('ETag')).toBe('"1"');
    expect(read.body).toEqual(res.body);
  });

  it('[FR-PO-07] three lines of 0.1 × 1 total exactly 0.3000', async () => {
    const h = await ordersHarness();
    const tenth = lineBody({ quantity: 1, unitPrice: '0.1' });
    const res = await h.createOrder(h.orderBody([tenth, tenth, tenth]));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ total: '0.3000' });
  });

  it('[FR-PO-05] consecutive creates take consecutive PO numbers', async () => {
    const h = await ordersHarness();
    const a = (await h.createOrder(h.orderBody())).body as { poNumber: string };
    const b = (await h.createOrder(h.orderBody())).body as { poNumber: string };
    const seq = (n: string) => Number(n.split('-').at(-1));
    expect(seq(b.poNumber)).toBe(seq(a.poNumber) + 1);
  });

  it('[NFR-VAL-01] a malformed order id is 400 INVALID_FORMAT; an unknown one 404', async () => {
    const h = await ordersHarness();
    const malformed = await h.getOrder('not-a-uuid');
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'path.id', code: 'INVALID_FORMAT' }],
    });
    const missing = await h.getOrder(UNKNOWN_ID);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('[FR-VEN-02] the vendor of a new order', () => {
  it('[FR-VEN-02] a vendor that does not exist is 400 VENDOR_NOT_FOUND, and nothing is written', async () => {
    const h = await ordersHarness();
    const res = await h.createOrder(h.orderBody([lineBody()], { vendorId: UNKNOWN_ID }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'body.vendorId', code: 'VENDOR_NOT_FOUND' }],
    });
    expect(await h.count('purchase_orders')).toBe(0);
    expect(await h.count('idempotency_keys')).toBe(0);
  });

  it('[FR-VEN-02] an inactive vendor is 409 VENDOR_INACTIVE, and nothing is written', async () => {
    const h = await ordersHarness();
    const inactive = await h.seedVendor({ name: 'Closed Co', status: 'INACTIVE' });
    const res = await h.createOrder(h.orderBody([lineBody()], { vendorId: inactive }));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'VENDOR_INACTIVE' });
    expect(await h.count('purchase_orders')).toBe(0);
    const [counter] = await h.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM po_number_counters`,
    );
    expect(counter?.n).toBe(0);
  });
});

describe('[NFR-VAL-01] strict create bodies', () => {
  it('[NFR-VAL-01] every failing field is named, before any business rule runs', async () => {
    const h = await ordersHarness();
    const res = await h.createOrder({
      vendorId: UNKNOWN_ID,
      lines: [
        lineBody({ description: '   ', quantity: 0, unitPrice: '-1' }),
        lineBody({ quantity: 1.5, unitPrice: '12.34567' }),
        lineBody({ quantity: 1_000_001, unitPrice: 12.5 }),
        lineBody({ description: 'a\tb', unitPrice: '1000000000' }),
      ],
    });
    expect(res.status).toBe(400);
    // VENDOR_NOT_FOUND isn't among them: the vendor is checked only after validation.
    expect((res.body as { details: unknown[] }).details).toEqual(
      expect.arrayContaining([
        { path: 'body.lines.0.description', code: 'TOO_SHORT' },
        { path: 'body.lines.0.quantity', code: 'OUT_OF_RANGE' },
        { path: 'body.lines.0.unitPrice', code: 'INVALID_FORMAT' },
        { path: 'body.lines.1.quantity', code: 'INVALID_FORMAT' },
        { path: 'body.lines.1.unitPrice', code: 'INVALID_FORMAT' },
        { path: 'body.lines.2.quantity', code: 'OUT_OF_RANGE' },
        { path: 'body.lines.2.unitPrice', code: 'INVALID_FORMAT' },
        { path: 'body.lines.3.description', code: 'INVALID_FORMAT' },
        { path: 'body.lines.3.unitPrice', code: 'INVALID_FORMAT' },
      ]),
    );
    expect((res.body as { details: unknown[] }).details).toHaveLength(9);
    expect(await h.count('purchase_orders')).toBe(0);
  });

  it('[NFR-VAL-01] no lines, or more than 500, are refused', async () => {
    const h = await ordersHarness();
    for (const [lines, code] of [
      [[], 'TOO_SHORT'],
      [Array.from({ length: 501 }, () => lineBody()), 'TOO_LONG'],
    ] as const) {
      const res = await h.createOrder(h.orderBody([...lines]));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ details: [{ path: 'body.lines', code }] });
    }
  });

  it('[NFR-VAL-01] derived and system fields are READ_ONLY_FIELD, any other extra field UNKNOWN_FIELD', async () => {
    const h = await ordersHarness();
    const res = await h.createOrder(
      h.orderBody([lineBody({ lineTotal: '1', sku: 'X' })], {
        total: '1',
        poNumber: 'PO-1',
        notes: 'x',
      }),
    );
    expect(res.status).toBe(400);
    expect(
      (res.body as { details: { path: string; code: string }[] }).details
        .map((d) => `${d.path} ${d.code}`)
        .sort(),
    ).toEqual(
      [
        'body.lines.0.lineTotal READ_ONLY_FIELD',
        'body.lines.0.sku UNKNOWN_FIELD',
        'body.notes UNKNOWN_FIELD',
        'body.poNumber READ_ONLY_FIELD',
        'body.total READ_ONLY_FIELD',
      ].sort(),
    );
  });

  it('[NFR-CON-01] a missing or malformed Idempotency-Key is 400', async () => {
    const h = await ordersHarness();
    const missing = await h.createOrder(h.orderBody(), { key: null });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({
      details: [{ path: 'header.idempotency-key', code: 'REQUIRED' }],
    });
    const malformed = await h.createOrder(h.orderBody(), { key: 'retry-1' });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({
      details: [{ path: 'header.idempotency-key', code: 'INVALID_FORMAT' }],
    });
    expect(await h.count('purchase_orders')).toBe(0);
  });
});

describe('[NFR-CON-01] idempotent creates', () => {
  it('[NFR-CON-01] a retry with the same key and body returns the original order; no second order or number', async () => {
    const h = await ordersHarness();
    const key = randomUUID();
    const first = await h.createOrder(h.orderBody(), { key });
    // The same body, its keys in another order and with other whitespace in the text.
    const retry = await h.createOrder(
      {
        lines: [{ unitPrice: '12.5', quantity: 10, description: ' Hex bolts M8 ' }],
        vendorId: h.vendorId,
      },
      { key },
    );
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    expect(retry.get('ETag')).toBe(first.get('ETag'));
    expect(retry.get('Location')).toBe(first.get('Location'));
    expect(await h.count('purchase_orders')).toBe(1);
    const next = (await h.createOrder(h.orderBody())).body as { poNumber: string };
    const seq = (n: string) => Number(n.split('-').at(-1));
    expect(seq(next.poNumber)).toBe(seq((first.body as { poNumber: string }).poNumber) + 1);
  });

  it('[NFR-CON-01] the same key with a different body is 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const h = await ordersHarness();
    const key = randomUUID();
    expect((await h.createOrder(h.orderBody(), { key })).status).toBe(201);
    const other = await h.createOrder(h.orderBody([lineBody({ quantity: 11 })]), { key });
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await h.count('purchase_orders')).toBe(1);
  });

  it('[NFR-CON-01] a key is per user: two Buyers with the same key create two orders', async () => {
    const h = await ordersHarness();
    const other = await h.loggedIn(await h.seedUser({ roles: '{BUYER}' }));
    const key = randomUUID();
    expect((await h.createOrder(h.orderBody(), { key })).status).toBe(201);
    expect((await h.createOrder(h.orderBody(), { key, as: other })).status).toBe(201);
    expect(await h.count('purchase_orders')).toBe(2);
  });

  it('[NFR-CON-01] a refused create keeps no key: fixing the body and retrying with it succeeds', async () => {
    const h = await ordersHarness();
    const key = randomUUID();
    const inactive = await h.seedVendor({ name: 'Closed Co', status: 'INACTIVE' });
    expect(
      (await h.createOrder(h.orderBody([lineBody()], { vendorId: inactive }), { key })).status,
    ).toBe(409);
    expect((await h.createOrder(h.orderBody(), { key })).status).toBe(201);
  });
});
