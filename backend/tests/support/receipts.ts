import { randomUUID } from 'node:crypto';
import type { CookieJar } from './accounts.js';
import { lineBody, ordersHarness } from './orders.js';

// The real API with a logged-in Buyer, helpers to raise an approved order and to record
// and read its receipts through the API (slice 6 receipt tests).

/** A receipt body: the receipt date and lines; `extra` replaces or adds fields. */
export function receiptBody(
  receivedOn: string,
  lines: { lineId: string; quantity: number }[],
  extra: Record<string, unknown> = {},
) {
  return { receivedOn, lines, ...extra };
}

/** The India date of `time` (`YYYY-MM-DD`), `days` days on. */
export function indiaDate(time: Date, days = 0): string {
  const shifted = new Date(time.getTime() + days * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(shifted);
}

/** 00:30 in India on `date` (`YYYY-MM-DD`): 19:00 UTC the day before. */
export function indiaHalfPastMidnight(date: string): Date {
  return new Date(`${date}T00:30:00+05:30`);
}

export async function receiptsHarness() {
  const h = await ordersHarness();
  /** The Buyer's session: renewed when the clock moves, so it never expires under a test. */
  let jar = h.jar;

  /** Moves the clock and logs the Buyer in again at the new time. */
  async function setClock(time: Date) {
    h.clock.set(time);
    jar = await h.loggedIn(h.buyer);
    return jar;
  }

  /**
   * An order of one line per quantity (₹1 each, so the submit auto-approves it: version
   * 2), approved through the API; with its line ids and its approval date in India time.
   */
  async function approvedOrder(quantities: number[] = [100], as: CookieJar = jar) {
    const created = await h.createOrder(
      h.orderBody(quantities.map((quantity) => lineBody({ quantity, unitPrice: '1' }))),
      { as },
    );
    const draft = created.body as { id: string; lines: { id: string }[] };
    await h.submitOrder(draft.id, 1, as);
    const [row] = await h.query<{ approved_on: string }>(
      `SELECT ((approved_at AT TIME ZONE 'Asia/Kolkata')::date)::text AS approved_on
         FROM purchase_orders WHERE id = $1`,
      [draft.id],
    );
    return {
      id: draft.id,
      lineIds: draft.lines.map((l) => l.id),
      approvedOn: row?.approved_on ?? '',
    };
  }

  /** POST /orders/:id/receipts with a fresh Idempotency-Key unless one is given; null none. */
  function recordReceipt(
    orderId: string,
    body: unknown,
    { key = randomUUID(), as = jar }: { key?: string | null; as?: CookieJar } = {},
  ) {
    return h.send(
      'post',
      `/orders/${orderId}/receipts`,
      as,
      body,
      key === null ? {} : { 'Idempotency-Key': key },
    );
  }

  function listReceipts(orderId: string, as: CookieJar = jar, query = '') {
    return h.get(`/orders/${orderId}/receipts${query}`, as);
  }

  function getReceipt(orderId: string, receiptId: string, as: CookieJar = jar) {
    return h.get(`/orders/${orderId}/receipts/${receiptId}`, as);
  }

  async function receiptAudit() {
    return (await h.orderAudit()).filter((e) => e.action === 'GOODS_RECEIPT_RECORDED');
  }

  async function receiptCounts(orderId: string) {
    const [row] = await h.query<{ receipts: number; lines: number }>(
      `SELECT (SELECT count(*)::int FROM goods_receipts WHERE order_id = $1) AS receipts,
              (SELECT count(*)::int FROM goods_receipt_lines WHERE order_id = $1) AS lines`,
      [orderId],
    );
    return row;
  }

  return {
    ...h,
    setClock,
    getOrder: (id: string, as: CookieJar = jar) => h.getOrder(id, as),
    approvedOrder,
    recordReceipt,
    listReceipts,
    getReceipt,
    receiptAudit,
    receiptCounts,
  };
}

export type ReceiptsHarness = Awaited<ReturnType<typeof receiptsHarness>>;
