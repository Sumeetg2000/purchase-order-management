import { AppError } from '@po/contracts';
import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import { withTransaction, type AuditedTransaction } from '../../src/db/transaction.js';
import { requireActiveVendor } from '../../src/vendors/service.js';
import { testLogger } from '../support/log-capture.js';
import { vendorsHarness, type VendorsHarness } from '../support/vendors.js';

// The active check the order slices call inside their own transaction (FR-011, FR-012;
// research R9), exercised here by a test-only caller since no order exists yet.

const clients: AppPrismaClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.$disconnect()));
});

/** A po_app client and a caller that runs `fn` in one transaction, as an order would. */
function caller(h: VendorsHarness) {
  const prisma = createPrismaClient({
    url: h.db.url('po_app'),
    poolSize: 3,
    connectionTimeoutMs: 2_000,
  });
  clients.push(prisma);
  return <T>(fn: (tx: AuditedTransaction) => Promise<T>) =>
    withTransaction(
      {
        prisma,
        actor: { type: 'SYSTEM' },
        requestId: 'req-active-check',
        timeoutMs: 10_000,
        maxWaitMs: 2_000,
        logger: testLogger(),
      },
      fn,
    );
}

/** A transaction that has passed the check and stays open until `release` is called. */
async function holdCheck(inTx: ReturnType<typeof caller>, vendorId: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let checked!: () => void;
  const ready = new Promise<void>((resolve) => (checked = resolve));
  const done = inTx(async (tx) => {
    await requireActiveVendor(tx, vendorId, 'body.vendorId');
    checked();
    await released;
  });
  // A check that throws ends the wait too, so a failure surfaces instead of a timeout.
  await Promise.race([ready, done]);
  return { release, done };
}

/** Waits until `count` backends wait on another transaction (here, a row lock). */
async function waitForRowWaiters(client: pg.Client, count: number): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    const { rows } = await client.query<{ waiting: string }>(
      `SELECT count(*) AS waiting FROM pg_locks
        WHERE locktype IN ('transactionid', 'tuple') AND NOT granted`,
    );
    if (Number(rows[0]?.waiting) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fewer than ${String(count)} transactions waited on the vendor row`);
}

describe('[FR-VEN-02] the vendor active check', () => {
  it('[FR-VEN-02] a missing vendor id is 400 VALIDATION_FAILED with VENDOR_NOT_FOUND at the caller path', async () => {
    const h = await vendorsHarness();
    const inTx = caller(h);
    const error: unknown = await inTx((tx) =>
      requireActiveVendor(tx, '00000000-0000-4000-8000-000000000000', 'body.vendorId'),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 400,
      details: [{ path: 'body.vendorId', code: 'VENDOR_NOT_FOUND' }],
    });
  });

  it('[FR-VEN-02] a malformed vendor id is the same VENDOR_NOT_FOUND, and the transaction goes on', async () => {
    const h = await vendorsHarness();
    const inTx = caller(h);
    const error: unknown = await inTx(async (tx) => {
      const refused: unknown = await requireActiveVendor(tx, 'not-a-uuid', 'body.vendorId').catch(
        (caught: unknown) => caught,
      );
      // The transaction is still usable: nothing failed inside PostgreSQL.
      await tx.$queryRaw`SELECT 1`;
      throw refused;
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 400,
      details: [{ path: 'body.vendorId', code: 'VENDOR_NOT_FOUND' }],
    });
  });

  it('[FR-VEN-02] an inactive vendor is 409 VENDOR_INACTIVE', async () => {
    const h = await vendorsHarness();
    const id = await h.seedVendor({ name: 'Acme Supplies', status: 'INACTIVE' });
    const error: unknown = await caller(h)((tx) =>
      requireActiveVendor(tx, id, 'body.vendorId'),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'VENDOR_INACTIVE', status: 409 });
  });

  it('[FR-VEN-03] an active vendor returns its order snapshot: id, name, contacts, payment terms', async () => {
    const h = await vendorsHarness();
    const id = await h.seedVendor({ name: 'Acme Supplies', contactPhone: '022 4000 1000' });
    const snapshot = await caller(h)((tx) => requireActiveVendor(tx, id, 'body.vendorId'));
    expect(snapshot).toStrictEqual({
      id,
      name: 'Acme Supplies',
      contactName: 'Ravi Shah',
      contactEmail: 'ravi@acme.example',
      contactPhone: '022 4000 1000',
      paymentTerms: { type: 'NET', netDays: 30 },
    });
  });

  it('[FR-VEN-02] a deactivate started while a check holds the vendor waits until that transaction ends', async () => {
    const h = await vendorsHarness();
    const id = await h.seedVendor({ name: 'Acme Supplies' });
    const held = await holdCheck(caller(h), id);

    let settled = false;
    const deactivating = h.setStatus(id, 'deactivate', 1).then((res) => {
      settled = true;
      return res;
    });
    const watcher = await h.db.client('postgres');
    await waitForRowWaiters(watcher, 1);
    expect(settled).toBe(false);

    held.release();
    await held.done;
    const res = await deactivating;
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'INACTIVE', version: 2 });
  });

  it("[FR-VEN-02] two checks of one vendor don't block each other", async () => {
    const h = await vendorsHarness();
    const id = await h.seedVendor({ name: 'Acme Supplies' });
    const inTx = caller(h);
    const held = await holdCheck(inTx, id);

    // The second check completes while the first transaction still holds its lock.
    const second = await inTx((tx) => requireActiveVendor(tx, id, 'body.vendorId'));
    expect(second).toMatchObject({ id, name: 'Acme Supplies' });

    held.release();
    await held.done;
  });
});
