import { describe, expect, it } from 'vitest';
import { readReconciliationSql } from '../../src/db/reconciliation.js';
import request from 'supertest';
import { APP_ORIGIN, type CookieJar } from '../support/accounts.js';
import {
  indiaDate,
  receiptBody,
  receiptsHarness,
  type ReceiptsHarness,
} from '../support/receipts.js';

// Receipts under concurrent requests (US4; specs/007-goods-receipt/research.md R11, races
// 1–8). Every interleaving is forced on PostgreSQL's own locks: a lock held on the test's
// own connection, released only once pg_stat_activity shows the requests waiting on it,
// so the order the requests run in is known; never a sleep. Where either order can happen,
// both are tested. Each race asserts its business outcome, that no transaction hit a
// deadlock (the runner logs every retried 40P01), and that reconciliation returns no row,
// INV-3 included.

type Response = { status: number; body: unknown };
type Started = PromiseLike<Response>;

/** Sends a request now: supertest only sends once something calls its `then`. */
const start = (request: PromiseLike<Response>): Promise<Response> =>
  new Promise((resolve, reject) => {
    request.then(resolve, reject);
  });

/** Business outcomes are repeated (SC-001, research R11); the order alternates where it matters. */
const RUNS = 10;

async function harness() {
  const h = await receiptsHarness();
  const jar = await h.setClock(new Date());
  return { h, jar, today: indiaDate(new Date()) };
}

/** Waits until at least `n` backends of this database wait on a lock; false on timeout. */
async function waiters(h: ReceiptsHarness, n: number, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Inside the transaction that holds the lock, the activity view keeps its first
    // snapshot until told to drop it.
    await h.query('SELECT pg_stat_clear_snapshot()');
    const [row] = await h.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if ((row?.n ?? 0) >= n) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

/** The relations the backend waiting on a lock already holds locks on. */
async function heldByWaiter(h: ReceiptsHarness, running = '%'): Promise<string[]> {
  await h.query('SELECT pg_stat_clear_snapshot()');
  const rows = await h.query<{ relname: string }>(
    `SELECT DISTINCT c.relname
       FROM pg_locks l
       JOIN pg_stat_activity a ON a.pid = l.pid
       JOIN pg_class c ON c.oid = l.relation
      WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()
        AND a.wait_event_type = 'Lock' AND l.granted AND l.mode = 'RowShareLock'
        AND a.query LIKE $1`,
    [running],
  );
  return rows.map((r) => r.relname).sort();
}

/**
 * Runs `steps` in order while the order row is held FOR UPDATE on the test's connection:
 * each step starts one request and waits until it is blocked, so they queue on the order
 * in the given order; then the row is released.
 */
async function inOrder(h: ReceiptsHarness, orderId: string, steps: (() => Started)[]) {
  await h.query('BEGIN');
  await h.query(`SELECT 1 FROM purchase_orders WHERE id = $1 FOR UPDATE`, [orderId]);
  const started: Promise<Response>[] = [];
  for (const [i, step] of steps.entries()) {
    started.push(start(step()));
    expect(await waiters(h, i + 1), `request ${String(i + 1)} waits on the order`).toBe(true);
  }
  await h.query('COMMIT');
  return Promise.all(started);
}

/** No transaction deadlocked, and every invariant still holds. */
async function settled(h: ReceiptsHarness, label: string) {
  const deadlocks = h.logs.filter((line) => line['sqlstate'] === '40P01');
  expect(deadlocks, `${label}: deadlocks`).toEqual([]);
  expect(await h.query(readReconciliationSql()), `${label}: reconciliation`).toEqual([]);
}

async function received(h: ReceiptsHarness, orderId: string) {
  const rows = await h.query<{ received_quantity: number }>(
    `SELECT received_quantity FROM order_lines WHERE order_id = $1 ORDER BY position`,
    [orderId],
  );
  return rows.map((r) => r.received_quantity);
}

async function statusOf(h: ReceiptsHarness, orderId: string) {
  const [row] = await h.query<{ status: string }>(
    `SELECT status FROM purchase_orders WHERE id = $1`,
    [orderId],
  );
  return row?.status;
}

const codeOf = (res: Response) => (res.body as { code?: string }).code;

describe('[FR-RCV-04] receipts racing receipts', () => {
  it('[FR-RCV-04] race 1: 50 single-unit receipts on a line with 30 outstanding: exactly 30 recorded', async () => {
    const { h, today } = await harness();
    for (let run = 0; run < 3; run += 1) {
      const order = await h.approvedOrder([30]);
      const lineId = order.lineIds[0] ?? '';
      // Hold the order while all 50 start, so they contend on it for real.
      await h.query('BEGIN');
      await h.query(`SELECT 1 FROM purchase_orders WHERE id = $1 FOR UPDATE`, [order.id]);
      const all = Array.from({ length: 50 }, () =>
        start(h.recordReceipt(order.id, receiptBody(today, [{ lineId, quantity: 1 }]))),
      );
      // The pool (4 connections) is the most that can wait at once; the rest queue for it.
      expect(await waiters(h, 4)).toBe(true);
      await h.query('COMMIT');
      const results = await Promise.all(all);
      const statuses = results.map((r) => r.status);
      expect(
        statuses.filter((s) => s === 201),
        `run ${String(run)}`,
      ).toHaveLength(30);
      expect(
        statuses.filter((s) => s === 409),
        `run ${String(run)}`,
      ).toHaveLength(20);
      for (const refused of results.filter((r) => r.status === 409)) {
        expect(codeOf(refused)).toBe('RECEIPT_EXCEEDS_OUTSTANDING');
      }
      expect(await received(h, order.id)).toEqual([30]);
      expect(await h.receiptCounts(order.id)).toEqual({ receipts: 30, lines: 30 });
      const entries = (await h.receiptAudit()).filter((e) => e.order_id === order.id);
      expect(entries).toHaveLength(30);
      await settled(h, `run ${String(run)}`);
    }
  });

  it('[FR-RCV-04] race 2: overlapping multi-line receipts, both orders: both fit, both recorded; only one fits, the first in full, the other refused in full', async () => {
    const { h, today } = await harness();
    for (let run = 0; run < RUNS; run += 1) {
      const order = await h.approvedOrder([10, 10, 10]);
      const [a = '', b = '', c = ''] = order.lineIds;
      const fit = run % 2 === 0;
      const x = receiptBody(today, [
        { lineId: a, quantity: fit ? 5 : 10 },
        { lineId: b, quantity: fit ? 5 : 6 },
      ]);
      const y = receiptBody(today, [
        { lineId: b, quantity: 5 },
        { lineId: c, quantity: fit ? 5 : 10 },
      ]);
      const xFirst = run % 4 < 2;
      const [first, second] = await inOrder(h, order.id, [
        () => h.recordReceipt(order.id, xFirst ? x : y),
        () => h.recordReceipt(order.id, xFirst ? y : x),
      ]);
      const label = `run ${String(run)}: ${fit ? 'both fit' : 'one fits'}, ${xFirst ? 'x' : 'y'} first`;
      expect(first?.status, label).toBe(201);
      if (fit) {
        expect(second?.status, label).toBe(201);
        expect(await received(h, order.id), label).toEqual([5, 10, 5]);
      } else {
        expect(second?.status, label).toBe(409);
        expect(second?.body, label).toMatchObject({
          code: 'RECEIPT_EXCEEDS_OUTSTANDING',
          lines: [{ lineId: b }],
        });
        expect(await received(h, order.id), label).toEqual(xFirst ? [10, 6, 0] : [0, 5, 10]);
      }
      await settled(h, label);
    }
  });

  it('[FR-RCV-04] race 3: receipts on different lines of one order all record; they serialize on the order', async () => {
    const { h, today } = await harness();
    for (let run = 0; run < RUNS; run += 1) {
      const order = await h.approvedOrder([4, 4, 4]);
      const results = await inOrder(
        h,
        order.id,
        order.lineIds.map(
          (lineId) => () =>
            h.recordReceipt(order.id, receiptBody(today, [{ lineId, quantity: 4 }])),
        ),
      );
      expect(
        results.map((r) => r.status),
        `run ${String(run)}`,
      ).toEqual([201, 201, 201]);
      expect(await received(h, order.id)).toEqual([4, 4, 4]);
      await settled(h, `run ${String(run)}`);
    }
  });

  it('[NFR-CON-01] race 7: the same Idempotency-Key twice at once: one recorded, the other replays it', async () => {
    const { h, today } = await harness();
    for (let run = 0; run < RUNS; run += 1) {
      const order = await h.approvedOrder([10]);
      const body = receiptBody(today, [{ lineId: order.lineIds[0] ?? '', quantity: 3 }]);
      const key = crypto.randomUUID();
      const [first, second] = await inOrder(h, order.id, [
        () => h.recordReceipt(order.id, body, { key }),
        // Waits on the first's uncommitted key row, then finds it.
        () => h.recordReceipt(order.id, body, { key }),
      ]);
      expect([first?.status, second?.status], `run ${String(run)}`).toEqual([201, 201]);
      expect(second?.body).toEqual(first?.body);
      expect(await h.receiptCounts(order.id)).toEqual({ receipts: 1, lines: 1 });
      expect(await received(h, order.id)).toEqual([3]);
      await settled(h, `run ${String(run)}`);
    }
  });
});

describe('[FR-LCK-02] receipts racing a cancel', () => {
  it('[FR-LCK-02] race 4: a receipt that fully receives vs a cancel, both orders: received and the cancel 409 ORDER_FULLY_RECEIVED, or cancelled and the receipt 409 ORDER_NOT_RECEIVABLE', async () => {
    const { h, today } = await harness();
    const priya = await h.approver();
    for (let run = 0; run < RUNS; run += 1) {
      const order = await h.approvedOrder([5]);
      const receipt = () =>
        h.recordReceipt(
          order.id,
          receiptBody(today, [{ lineId: order.lineIds[0] ?? '', quantity: 5 }]),
        );
      const cancel = () => h.cancelOrder(order.id, 2, priya.jar, { reason: 'Supplier closed' });
      const receiptFirst = run % 2 === 0;
      const results = await inOrder(
        h,
        order.id,
        receiptFirst ? [receipt, cancel] : [cancel, receipt],
      );
      const [byReceipt, byCancel] = receiptFirst ? results : [results[1], results[0]];
      const label = `run ${String(run)}: ${receiptFirst ? 'receipt' : 'cancel'} first`;
      if (receiptFirst) {
        expect(byReceipt?.status, label).toBe(201);
        expect(byCancel?.status, label).toBe(409);
        expect(codeOf(byCancel as Response), label).toBe('ORDER_FULLY_RECEIVED');
        expect(await statusOf(h, order.id), label).toBe('APPROVED');
      } else {
        expect(byCancel?.status, label).toBe(200);
        expect(byReceipt?.status, label).toBe(409);
        expect(byReceipt?.body, label).toMatchObject({
          code: 'ORDER_NOT_RECEIVABLE',
          orderState: { status: 'CANCELLED' },
        });
        expect(await received(h, order.id), label).toEqual([0]);
      }
      await settled(h, label);
    }
  });

  it('[FR-LCK-02] race 5: a partial receipt vs a cancel, both orders: cancelled partly received (the cancel records it), or cancelled and the receipt refused', async () => {
    const { h, today } = await harness();
    const priya = await h.approver();
    for (let run = 0; run < RUNS; run += 1) {
      const order = await h.approvedOrder([5]);
      const lineId = order.lineIds[0] ?? '';
      const receipt = () =>
        h.recordReceipt(order.id, receiptBody(today, [{ lineId, quantity: 2 }]));
      const cancel = () => h.cancelOrder(order.id, 2, priya.jar, { reason: 'Supplier closed' });
      const receiptFirst = run % 2 === 0;
      const results = await inOrder(
        h,
        order.id,
        receiptFirst ? [receipt, cancel] : [cancel, receipt],
      );
      const [byReceipt, byCancel] = receiptFirst ? results : [results[1], results[0]];
      const label = `run ${String(run)}: ${receiptFirst ? 'receipt' : 'cancel'} first`;
      expect(byCancel?.status, label).toBe(200);
      expect(await statusOf(h, order.id), label).toBe('CANCELLED');
      const [cancelled] = (await h.orderAudit()).filter(
        (e) => e.action === 'PO_CANCELLED' && e.order_id === order.id,
      );
      const recordedLine = (cancelled?.details as { lines: { receivedQuantity: number }[] })
        .lines[0];
      if (receiptFirst) {
        expect(byReceipt?.status, label).toBe(201);
        // The cancel saw the receipt: the order is "Cancelled · partly received".
        expect(recordedLine?.receivedQuantity, label).toBe(2);
        expect(byCancel?.body, label).toMatchObject({ receiptProgress: 'PARTIALLY_RECEIVED' });
      } else {
        expect(byReceipt?.status, label).toBe(409);
        expect(codeOf(byReceipt as Response), label).toBe('ORDER_NOT_RECEIVABLE');
        expect(recordedLine?.receivedQuantity, label).toBe(0);
      }
      await settled(h, label);
    }
  });
});

describe('[FR-ACC-07] a receipt racing a change to its owner', () => {
  for (const [change, admin, code] of [
    ['deactivation', { isActive: false }, 'ACCOUNT_DEACTIVATED'],
    ['BUYER removal', { roles: ['APPROVER'] }, 'FORBIDDEN'],
  ] as const) {
    it(`[FR-ACC-07] race 6, ${change} first: the admin's change holds the users row, the receipt waits on it holding the order and lines; the re-check under lock refuses it`, async () => {
      const { h, today } = await harness();
      const adminJar = await h.loggedIn(await h.seedUser({ roles: '{ADMIN}' }));
      for (let run = 0; run < RUNS; run += 1) {
        const owner = await h.seedUser({ roles: '{BUYER}', name: `Owner ${String(run)}` });
        const jar: CookieJar = await h.loggedIn(owner);
        const order = await h.approvedOrder([5], jar);
        const label = `run ${String(run)}`;
        // The real admin change (users row FOR NO KEY UPDATE, the update, the sessions
        // revoked), paused at its audit entry, so it holds the users row uncommitted.
        await h.query('BEGIN');
        await h.query('LOCK TABLE audit_entries IN SHARE MODE');
        const changing = start(
          h.send('patch', `/admin/users/${owner.id}`, adminJar, admin, { 'If-Match': '"1"' }),
        );
        expect(await waiters(h, 1), `${label}: the change waits at its audit entry`).toBe(true);
        // The receipt's key claim (KEY SHARE on the users row) passes the change; the
        // receipt then waits at its FOR SHARE re-check, holding the order and its lines.
        const receipt = start(
          h.recordReceipt(
            order.id,
            receiptBody(today, [{ lineId: order.lineIds[0] ?? '', quantity: 2 }]),
            { as: jar },
          ),
        );
        expect(await waiters(h, 2), `${label}: the receipt waits on the users row`).toBe(true);
        expect(await heldByWaiter(h, '%FOR SHARE%'), label).toEqual(
          expect.arrayContaining(['order_lines', 'purchase_orders']),
        );
        await h.query('COMMIT');
        const [res, changed] = await Promise.all([receipt, changing]);
        expect(changed.status, label).toBe(200);
        expect(codeOf(res), label).toBe(code);
        expect(await h.receiptCounts(order.id), label).toEqual({ receipts: 0, lines: 0 });
        await settled(h, label);
      }
    });

    it(`[FR-ACC-07] race 6, receipt first: the ${change} waits on the receipt's users row lock; recorded before the change`, async () => {
      const { h, today } = await harness();
      const adminJar = await h.loggedIn(await h.seedUser({ roles: '{ADMIN}' }));
      for (let run = 0; run < RUNS; run += 1) {
        const owner = await h.seedUser({ roles: '{BUYER}', name: `Owner ${String(run)}` });
        const jar: CookieJar = await h.loggedIn(owner);
        const order = await h.approvedOrder([5], jar);
        // Stop the receipt just after its locks (order, lines, users row) at its insert.
        await h.query('BEGIN');
        await h.query('LOCK TABLE goods_receipts IN SHARE MODE');
        const receipt = start(
          h.recordReceipt(
            order.id,
            receiptBody(today, [{ lineId: order.lineIds[0] ?? '', quantity: 2 }]),
            { as: jar },
          ),
        );
        expect(await waiters(h, 1), `run ${String(run)}: the receipt waits`).toBe(true);
        const changing = start(
          h.send('patch', `/admin/users/${owner.id}`, adminJar, admin, {
            'If-Match': '"1"',
          }),
        );
        expect(await waiters(h, 2), `run ${String(run)}: the change waits on the receipt`).toBe(
          true,
        );
        await h.query('COMMIT');
        const [res, changed] = await Promise.all([receipt, changing]);
        const label = `run ${String(run)}`;
        expect(res.status, label).toBe(201);
        expect(changed.status, label).toBe(200);
        expect(await h.receiptCounts(order.id), label).toEqual({ receipts: 1, lines: 1 });
        await settled(h, label);
      }
    });
  }
});

describe('[FR-VEN-02] a receipt racing its vendor', () => {
  it("[FR-VEN-02] race 8: a receipt and the vendor's deactivation, both orders: both succeed", async () => {
    const { h, jar, today } = await harness();
    for (let run = 0; run < RUNS; run += 1) {
      const vendorId = await h.seedVendor({ name: `Vendor ${String(run)}` });
      const created = await h.createOrder(
        h.orderBody([{ description: 'Bolts', quantity: 5, unitPrice: '1' }], { vendorId }),
        { as: jar },
      );
      const draft = created.body as { id: string; lines: { id: string }[] };
      await h.submitOrder(draft.id, 1, jar);
      const receipt = () =>
        h.recordReceipt(
          draft.id,
          receiptBody(today, [{ lineId: draft.lines[0]?.id ?? '', quantity: 2 }]),
        );
      const deactivate = () => h.setStatus(vendorId, 'deactivate', 1, jar).then((r) => r);
      const label = `run ${String(run)}`;
      if (run % 2 === 0) {
        // The receipt waits on the order; the vendor change, which doesn't touch the order,
        // completes meanwhile; then the receipt runs on the now-inactive vendor's order.
        await h.query('BEGIN');
        await h.query(`SELECT 1 FROM purchase_orders WHERE id = $1 FOR UPDATE`, [draft.id]);
        const waiting = start(receipt());
        expect(await waiters(h, 1), label).toBe(true);
        const changed = await deactivate();
        await h.query('COMMIT');
        const res = await waiting;
        expect([res.status, changed.status], label).toEqual([201, 200]);
      } else {
        const changed = await deactivate();
        const res = await receipt();
        expect([res.status, changed.status], label).toEqual([201, 200]);
      }
      await settled(h, label);
    }
  });
});

describe('[NFR-CON-01] a keyed command and its user row (ADR-0006)', () => {
  it("[NFR-CON-01] a password reset request doesn't wait on the user's in-flight receipt, which holds only its key's KEY SHARE", async () => {
    const { h, today } = await harness();
    const owner = await h.seedUser({ roles: '{BUYER}', name: 'Owner' });
    const jar: CookieJar = await h.loggedIn(owner);
    const order = await h.approvedOrder([5], jar);
    // The receipt claims its key (KEY SHARE on the users row), then waits on the order.
    await h.query('BEGIN');
    await h.query(`SELECT 1 FROM purchase_orders WHERE id = $1 FOR UPDATE`, [order.id]);
    let outcome: string | undefined;
    try {
      const receipt = start(
        h.recordReceipt(
          order.id,
          receiptBody(today, [{ lineId: order.lineIds[0] ?? '', quantity: 1 }]),
          { as: jar },
        ),
      );
      expect(await waiters(h, 1)).toBe(true);
      // Issuing the reset link locks the users row (FOR NO KEY UPDATE, never FOR UPDATE).
      const forgot = start(
        request(h.app)
          .post('/auth/forgot-password')
          .set('Origin', APP_ORIGIN)
          .send({ email: owner.email }),
      );
      outcome = await Promise.race([
        forgot.then((res) => (res.status === 202 ? 'link sent' : `status ${String(res.status)}`)),
        waiters(h, 2, 3_000).then((blocked) => (blocked ? 'reset waits' : 'timed out')),
      ]);
      await h.query('COMMIT');
      expect((await receipt).status).toBe(201);
    } finally {
      await h.query('ROLLBACK').catch(() => undefined);
    }
    expect(outcome).toBe('link sent');
    await settled(h, 'password reset during a receipt');
  });
});
