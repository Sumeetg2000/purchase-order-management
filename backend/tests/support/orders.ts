import { randomUUID } from 'node:crypto';
import type { CookieJar } from './accounts.js';
import { vendorsHarness } from './vendors.js';

// The real API with a logged-in Buyer and an active vendor, and helpers to create and read
// orders through it (slice 3 order tests).

export interface LineBody {
  description?: string;
  quantity?: unknown;
  unitPrice?: unknown;
  [extra: string]: unknown;
}

/** A valid line; `extra` replaces or adds fields. */
export function lineBody(extra: LineBody = {}): LineBody {
  return { description: 'Hex bolts M8', quantity: 10, unitPrice: '12.5', ...extra };
}

export async function ordersHarness() {
  const h = await vendorsHarness();
  const vendorId = await h.seedVendor({ name: 'Acme Supplies' });

  /** A valid create body for the harness's vendor; `extra` replaces or adds fields. */
  function orderBody(lines: unknown[] = [lineBody()], extra: Record<string, unknown> = {}) {
    return { vendorId, lines, ...extra };
  }

  /** POST /orders with a fresh Idempotency-Key unless one is given; null sends none. */
  function createOrder(
    body: unknown,
    { key = randomUUID(), as = h.jar }: { key?: string | null; as?: CookieJar } = {},
  ) {
    return h.send('post', '/orders', as, body, key === null ? {} : { 'Idempotency-Key': key });
  }

  /** PATCH /orders/:id, the full intended state; `version` null sends no If-Match. */
  function editOrder(id: string, body: unknown, version: number | null, as: CookieJar = h.jar) {
    const headers = version === null ? {} : { 'If-Match': `"${String(version)}"` };
    return h.send('patch', `/orders/${id}`, as, body, headers);
  }

  /** DELETE /orders/:id; `version` null sends no If-Match, `body` undefined none. */
  function deleteOrder(id: string, version: number | null, body?: unknown, as: CookieJar = h.jar) {
    const headers = version === null ? {} : { 'If-Match': `"${String(version)}"` };
    return h.send('delete', `/orders/${id}`, as, body, headers);
  }

  function getOrder(id: string, as: CookieJar = h.jar) {
    return h.get(`/orders/${id}`, as);
  }

  async function count(table: 'purchase_orders' | 'order_lines' | 'idempotency_keys') {
    const [row] = await h.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    return row?.n ?? 0;
  }

  async function orderAudit() {
    return h.query<{
      action: string;
      entity_type: string;
      entity_id: string;
      order_id: string | null;
      po_number: string | null;
      actor_type: string;
      actor_user_id: string | null;
      actor_name: string | null;
      actor_email: string | null;
      acting_role: string | null;
      request_id: string | null;
      details: unknown;
    }>(
      `SELECT action, entity_type, entity_id, order_id::text, po_number, actor_type,
              actor_user_id::text, actor_name, actor_email, acting_role, request_id, details
         FROM audit_entries WHERE entity_type = 'order' ORDER BY occurred_at, id`,
    );
  }

  return {
    ...h,
    vendorId,
    orderBody,
    createOrder,
    editOrder,
    deleteOrder,
    getOrder,
    count,
    orderAudit,
  };
}

export type OrdersHarness = Awaited<ReturnType<typeof ordersHarness>>;
