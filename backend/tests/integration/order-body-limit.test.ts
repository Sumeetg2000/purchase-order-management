import {
  BODY_LIMIT_BYTES,
  LINE_DESCRIPTION_MAX,
  LINE_QUANTITY_MAX,
  ORDER_ADMIN_READ_ONLY_MESSAGE,
  ORDER_BODY_LIMIT_BYTES,
  ORDER_LINES_MAX,
  UNIT_PRICE_MAX,
} from '@po/contracts';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_ORIGIN, cookieHeader, type CookieJar } from '../support/accounts.js';
import { ordersHarness } from '../support/orders.js';
import { listen, rawRequest, type RawServer } from '../support/raw-http.js';

// The order-write body limit, against the API itself, no proxy (research R8): the largest
// valid order fits however its client encodes JSON; one byte more is 413; and a write
// refused before its body is read (no session, no CSRF token, an Admin) is answered with
// the connection closed while the client still holds the rest.

const servers: RawServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const EMOJI = '\u{1F600}';

function largestOrder(vendorId: string) {
  return {
    vendorId,
    lines: Array.from({ length: ORDER_LINES_MAX }, () => ({
      description: EMOJI.repeat(LINE_DESCRIPTION_MAX),
      quantity: LINE_QUANTITY_MAX,
      unitPrice: UNIT_PRICE_MAX,
    })),
  };
}

function writeHeaders(jar: CookieJar | null, { csrf = true }: { csrf?: boolean } = {}) {
  return {
    Origin: APP_ORIGIN,
    'Idempotency-Key': randomUUID(),
    ...(jar ? { Cookie: cookieHeader(jar, 'po_access') } : {}),
    ...(jar && csrf ? { 'X-CSRF-Token': jar['po_csrf'] ?? '' } : {}),
  };
}

async function setup() {
  const h = await ordersHarness();
  const server = await listen(h.app);
  servers.push(server);
  const base = `http://127.0.0.1:${String(server.port)}`;
  const post = (path: string, body: string, jar: CookieJar | null = h.jar) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { ...writeHeaders(jar), 'Content-Type': 'application/json' },
      body,
    });
  return { h, server, post };
}

describe('[NFR-VAL-01] the order-write body limit, at the API', () => {
  it('[NFR-VAL-01] the largest valid order is accepted as raw UTF-8 and fully escaped', async () => {
    const { h, post } = await setup();
    const raw = JSON.stringify(largestOrder(h.vendorId));
    // Every emoji as an escaped surrogate pair, as a client may emit valid JSON.
    const escaped = raw.replaceAll(EMOJI, '\\ud83d\\ude00');
    // About 1.03 MB raw (an edit's line ids take it past 1 MiB); escaped, about 3 MB, it
    // needs the order-write limit (over 2 MiB, so 2 MiB would refuse a valid order).
    expect(Buffer.byteLength(raw)).toBeGreaterThan(1_000_000);
    expect(Buffer.byteLength(escaped)).toBeGreaterThan(2 * BODY_LIMIT_BYTES);
    expect(Buffer.byteLength(escaped)).toBeLessThanOrEqual(ORDER_BODY_LIMIT_BYTES);
    for (const body of [raw, escaped]) {
      const res = await post('/orders', body);
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ total: '499999999999950000.0000', lineCount: 500 });
    }
  });

  it('[NFR-VAL-01] the largest valid order is accepted as an edit, its line ids taking it past 1 MiB', async () => {
    const { h, post } = await setup();
    const created = await post('/orders', JSON.stringify(largestOrder(h.vendorId)));
    expect(created.status).toBe(201);
    const order = (await created.json()) as { id: string; lines: { id: string }[] };
    const body = largestOrder(h.vendorId);
    const edit = JSON.stringify({
      ...body,
      lines: body.lines.map((line, i) => ({ id: order.lines[i]?.id, ...line, quantity: 999_999 })),
    });
    expect(Buffer.byteLength(edit)).toBeGreaterThan(BODY_LIMIT_BYTES);
    const res = await h.editOrder(order.id, JSON.parse(edit) as unknown, 1);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: '499999499999950000.0500', version: 2 });
  });

  it('[NFR-VAL-01] a body one byte over the limit is 413, and nothing is written', async () => {
    const { h, post } = await setup();
    const res = await post('/orders', ' '.repeat(ORDER_BODY_LIMIT_BYTES + 1));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(await h.count('purchase_orders')).toBe(0);
  });

  it('[NFR-VAL-01] other writes keep the 1 MiB limit', async () => {
    const { post } = await setup();
    const res = await post('/vendors', ' '.repeat(BODY_LIMIT_BYTES + 1));
    expect(res.status).toBe(413);
  });

  it('[NFR-AUTH-01] no session, no CSRF token or an Admin: refused before the body is read, the connection closed', async () => {
    const { h, server } = await setup();
    const admin = await h.loggedIn(await h.seedUser({ roles: '{ADMIN}' }));
    const cases: [string, Record<string, string>, number, Record<string, string>][] = [
      ['no session', writeHeaders(null), 401, { code: 'UNAUTHENTICATED' }],
      ['no CSRF token', writeHeaders(h.jar, { csrf: false }), 403, { code: 'CSRF_REJECTED' }],
      [
        'an Admin',
        writeHeaders(admin),
        403,
        { code: 'FORBIDDEN', detail: ORDER_ADMIN_READ_ONLY_MESSAGE },
      ],
    ];
    for (const [name, headers, status, problem] of cases) {
      const res = await rawRequest(server.port, {
        method: 'POST',
        path: '/orders',
        headers,
        contentLength: ORDER_BODY_LIMIT_BYTES,
        sendBytes: 1024,
      });
      expect(res.status, name).toBe(status);
      expect(JSON.parse(res.body) as unknown, name).toMatchObject(problem);
      expect(res.headers['connection'], name).toBe('close');
      expect(res.closed, name).toBe(true);
      expect(server.lastBytesRead(), name).toBeLessThan(64 * 1024);
    }
    expect(await h.count('purchase_orders')).toBe(0);
  });

  it('[NFR-VAL-01] a chunked body past the limit is 413 and never parsed: no order is written', async () => {
    const { h, server } = await setup();
    const res = await rawRequest(server.port, {
      method: 'POST',
      path: '/orders',
      headers: writeHeaders(h.jar),
      chunkedBytes: ORDER_BODY_LIMIT_BYTES + 64 * 1024,
    });
    expect(res.status).toBe(413);
    expect(res.headers['connection']).toBe('close');
    expect(res.closed).toBe(true);
    expect(await h.count('purchase_orders')).toBe(0);
  });
});
