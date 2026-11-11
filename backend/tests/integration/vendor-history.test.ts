import { randomUUID } from 'node:crypto';
import type { VendorSnapshot } from '@po/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { writeAudit } from '../../src/audit/write.js';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import { withTransaction } from '../../src/db/transaction.js';
import { testLogger } from '../support/log-capture.js';
import { vendorBody, vendorsHarness, type VendorsHarness } from '../support/vendors.js';

// A vendor's history (spec US5; FR-013, FR-014; research R10): its audit entries, newest
// first, each with the actor as they were at the time and the vendor before → after.

const clients: AppPrismaClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.$disconnect()));
});

interface HistoryPage {
  items: {
    id: string;
    action: string;
    occurredAt: string;
    actor: { type: string; name: string | null; email: string | null; role: string | null };
    before: Record<string, unknown> | null;
    after: Record<string, unknown>;
  }[];
  page: number;
  pageSize: number;
  total: number;
}

function history(h: VendorsHarness, id: string, query = '', jar = h.jar) {
  return h.get(`/vendors/${id}/history${query}`, jar);
}

/** Create, edit, deactivate and reactivate one vendor through the API, as the Buyer. */
async function fourChanges(h: VendorsHarness): Promise<string> {
  const created = await h.createVendor(vendorBody());
  expect(created.status).toBe(201);
  const id = (created.body as { id: string }).id;
  expect((await h.updateVendor(id, vendorBody({ name: 'Acme Industrial' }), 1)).status).toBe(200);
  expect((await h.setStatus(id, 'deactivate', 2)).status).toBe(200);
  expect((await h.setStatus(id, 'reactivate', 3)).status).toBe(200);
  return id;
}

const ACME: VendorSnapshot = {
  name: 'Acme Supplies',
  contactName: 'Ravi Shah',
  contactEmail: 'ravi@acme.example',
  contactPhone: null,
  paymentTerms: { type: 'NET', netDays: 30 },
  status: 'ACTIVE',
};
const RENAMED: VendorSnapshot = { ...ACME, name: 'Acme Industrial' };

describe('[NFR-AUD-03] vendor history', () => {
  it('[NFR-AUD-03] four changes give four entries, newest first, with actor and before → after', async () => {
    const h = await vendorsHarness();
    const id = await fourChanges(h);

    const res = await history(h, id);
    expect(res.status).toBe(200);
    const body = res.body as HistoryPage;
    expect(body).toMatchObject({ page: 1, pageSize: 20, total: 4 });
    const actor = { type: 'USER', name: 'Bea Buyer', email: h.buyer.email, role: 'BUYER' };
    expect(
      body.items.map(({ action, actor: who, before, after }) => ({ action, who, before, after })),
    ).toEqual([
      {
        action: 'VENDOR_REACTIVATED',
        who: actor,
        before: { ...RENAMED, status: 'INACTIVE' },
        after: RENAMED,
      },
      {
        action: 'VENDOR_DEACTIVATED',
        who: actor,
        before: RENAMED,
        after: { ...RENAMED, status: 'INACTIVE' },
      },
      { action: 'VENDOR_UPDATED', who: actor, before: ACME, after: RENAMED },
      { action: 'VENDOR_CREATED', who: actor, before: null, after: ACME },
    ]);
    for (const item of body.items) {
      expect(item.id).toMatch(/^\d+$/);
      expect(new Date(item.occurredAt).toISOString()).toBe(item.occurredAt);
    }
  });

  it('[NFR-AUD-03] pages keep the newest-first order', async () => {
    const h = await vendorsHarness();
    const id = await fourChanges(h);
    const second = (await history(h, id, '?page=2&pageSize=3')).body as HistoryPage;
    expect(second).toMatchObject({ page: 2, pageSize: 3, total: 4 });
    expect(second.items.map((item) => item.action)).toEqual(['VENDOR_CREATED']);
  });

  it('[NFR-AUD-03] entries with the same timestamp come in a stable order, newest id first', async () => {
    const h = await vendorsHarness();
    const id = await h.seedVendor({ name: 'Acme Supplies' });
    const prisma = createPrismaClient({
      url: h.db.url('po_app'),
      poolSize: 1,
      connectionTimeoutMs: 2_000,
    });
    clients.push(prisma);
    // One transaction: the trigger stamps every entry with the same now().
    await withTransaction(
      {
        prisma,
        actor: { type: 'SYSTEM' },
        requestId: 'req-history-same-time',
        timeoutMs: 5_000,
        maxWaitMs: 2_000,
        logger: testLogger(),
      },
      async (tx) => {
        for (const contactName of ['First', 'Second', 'Third']) {
          await writeAudit(tx, {
            action: 'VENDOR_UPDATED',
            entityType: 'vendor',
            entityId: id,
            details: { before: ACME, after: { ...ACME, contactName } },
          });
        }
      },
    );

    const pages = await Promise.all([
      history(h, id, '?pageSize=2'),
      history(h, id, '?page=2&pageSize=2'),
    ]);
    const items = pages.flatMap((res) => (res.body as HistoryPage).items);
    expect(new Set(items.map((item) => item.occurredAt)).size).toBe(1);
    expect(items.map((item) => item.after.contactName)).toEqual(['Third', 'Second', 'First']);
    expect(items.map((item) => BigInt(item.id))).toEqual(
      items.map((item) => BigInt(item.id)).sort((a, b) => (a > b ? -1 : 1)),
    );
    expect(items[0]?.actor).toEqual({ type: 'SYSTEM', name: null, email: null, role: null });
  });

  it('[NFR-AUD-03] entries with the same timestamp order by id as a number, across a digit boundary', async () => {
    const h = await vendorsHarness();
    const id = await h.seedVendor({ name: 'Acme Supplies' });
    // Ids 98 to 101: as text, "99" sorts above "101".
    await h.query('ALTER TABLE audit_entries ALTER COLUMN id RESTART WITH 98');
    const prisma = createPrismaClient({
      url: h.db.url('po_app'),
      poolSize: 1,
      connectionTimeoutMs: 2_000,
    });
    clients.push(prisma);
    await withTransaction(
      {
        prisma,
        actor: { type: 'SYSTEM' },
        requestId: 'req-history-digit-boundary',
        timeoutMs: 5_000,
        maxWaitMs: 2_000,
        logger: testLogger(),
      },
      async (tx) => {
        for (const contactName of ['98', '99', '100', '101']) {
          await writeAudit(tx, {
            action: 'VENDOR_UPDATED',
            entityType: 'vendor',
            entityId: id,
            details: { before: ACME, after: { ...ACME, contactName } },
          });
        }
      },
    );

    const items = (await history(h, id)).body as HistoryPage;
    expect(items.items.map((item) => item.id)).toEqual(['101', '100', '99', '98']);
  });

  it("[NFR-AUD-03] an entry keeps the actor's name from the time, after they are renamed", async () => {
    const h = await vendorsHarness();
    const created = await h.createVendor(vendorBody());
    const id = (created.body as { id: string }).id;
    expect((await h.send('patch', '/me', h.jar, { name: 'Bea Renamed' })).status).toBe(200);

    const [entry] = ((await history(h, id)).body as HistoryPage).items;
    expect(entry?.actor.name).toBe('Bea Buyer');
  });

  it('[NFR-AUD-03] refused changes leave no entry', async () => {
    const h = await vendorsHarness();
    const created = await h.createVendor(vendorBody());
    const id = (created.body as { id: string }).id;
    await h.createVendor(vendorBody({ name: 'Beta Traders' }));
    const approver = await h.loggedIn(await h.seedUser({ roles: '{APPROVER}' }));

    expect((await h.updateVendor(id, vendorBody({ name: '' }), 1)).status).toBe(400);
    expect((await h.updateVendor(id, vendorBody({ name: 'Beta Traders' }), 1)).status).toBe(409);
    expect((await h.updateVendor(id, vendorBody(), 7)).status).toBe(409);
    expect((await h.setStatus(id, 'reactivate', 1)).status).toBe(409);
    expect((await h.setStatus(id, 'deactivate', 1, approver)).status).toBe(403);

    const body = (await history(h, id)).body as HistoryPage;
    expect(body.items.map((item) => item.action)).toEqual(['VENDOR_CREATED']);
    expect(body.total).toBe(1);
  });

  it('[NFR-AUD-03] an Admin reads the history; an Approver is 403; an unknown vendor is 404', async () => {
    const h = await vendorsHarness();
    const id = await h.seedVendor({ name: 'Acme Supplies' });
    const admin = await h.loggedIn(await h.seedUser({ roles: '{ADMIN}' }));
    const approver = await h.loggedIn(await h.seedUser({ roles: '{APPROVER}' }));

    const read = await history(h, id, '', admin);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ items: [], page: 1, pageSize: 20, total: 0 });

    const refused = await history(h, id, '', approver);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'FORBIDDEN' });

    const unknown = await history(h, randomUUID());
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: 'NOT_FOUND' });
  });
});
