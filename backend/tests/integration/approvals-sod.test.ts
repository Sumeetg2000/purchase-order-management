import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ERROR_CODES,
  SELF_APPROVAL_DETAIL,
  type ApprovalQueueItem,
  type Page,
} from '@po/contracts';
import { describe, expect, it } from 'vitest';
import { ordersHarness } from '../support/orders.js';

// Separation of duties, gathered by requirement (US6, ADR-0004): nobody decides an order
// they own, whatever roles they hold; a dual-role user decides others' orders as APPROVER.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

async function dual() {
  const h = await ordersHarness();
  const dev = await h.approver('{BUYER,APPROVER}', 'Dev Dual');
  const submit = async (jar = h.jar) => {
    const draft = await h.draftAt('500000', jar);
    await h.submitOrder(draft.id, 1, jar);
    return draft.id;
  };
  return { h, dev, submit };
}

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === 'generated' ? [] : sourceFiles(full);
      return /\.(ts|tsx|sql)$/.test(e.name) ? [full] : [];
    }),
  );
  return nested.flat();
}

describe('[FR-SOD-01] nobody decides an order they own', () => {
  it('[FR-SOD-01] a Buyer+Approver approving or rejecting their own order: 403 SELF_APPROVAL, nothing recorded', async () => {
    const { h, dev, submit } = await dual();
    const own = await submit(dev.jar);
    for (const res of [
      await h.approveOrder(own, 2, dev.jar),
      await h.rejectOrder(own, 2, dev.jar, { reason: 'Not needed after all' }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'SELF_APPROVAL', detail: SELF_APPROVAL_DETAIL });
    }
    const [row] = await h.query<{ status: string; state: string; n: number }>(
      `SELECT o.status, s.state,
              (SELECT count(*)::int FROM audit_entries
                WHERE order_id = o.id AND action LIKE 'APPROVAL_STEP_%') AS n
         FROM purchase_orders o JOIN approval_steps s ON s.order_id = o.id
        WHERE o.id = $1`,
      [own],
    );
    expect(row).toEqual({ status: 'PENDING_APPROVAL', state: 'OPEN', n: 0 });
  });

  it('[FR-SOD-01] the same user approves and rejects other buyers’ orders, recorded as APPROVER', async () => {
    const { h, dev, submit } = await dual();
    const toApprove = await submit();
    const toReject = await submit();
    expect((await h.approveOrder(toApprove, 2, dev.jar)).status).toBe(200);
    expect(
      (await h.rejectOrder(toReject, 2, dev.jar, { reason: 'Vendor quote expired' })).status,
    ).toBe(200);
    const decisions = (await h.orderAudit()).filter((e) => e.action.startsWith('APPROVAL_STEP_'));
    expect(decisions.map((e) => [e.action, e.actor_user_id, e.acting_role])).toEqual([
      ['APPROVAL_STEP_APPROVED', dev.id, 'APPROVER'],
      ['APPROVAL_STEP_REJECTED', dev.id, 'APPROVER'],
    ]);
  });

  it('[FR-013] their own pending order is in their order list, never in their queue or its count', async () => {
    const { h, dev, submit } = await dual();
    const own = await submit(dev.jar);
    const other = await submit();
    const list = (await h.get('/orders', dev.jar)).body as { items: { id: string }[] };
    expect(list.items.map((i) => i.id)).toEqual(expect.arrayContaining([own, other]));
    const queue = (await h.listQueue(dev.jar)).body as Page<ApprovalQueueItem>;
    expect(queue.items.map((i) => i.id)).toEqual([other]);
    const count = (await h.listQueue(dev.jar, { pageSize: 1 })).body as Page<ApprovalQueueItem>;
    expect(count.total).toBe(1);
  });

  it('[FR-SOD-01] DUPLICATE_APPROVER exists in neither the registry nor any source file', async () => {
    expect(ERROR_CODES).not.toContain('DUPLICATE_APPROVER');
    const dirs = ['backend/src', 'backend/prisma', 'frontend/src', 'packages/contracts/src'];
    const files = (await Promise.all(dirs.map((d) => sourceFiles(path.join(root, d))))).flat();
    expect(files.length).toBeGreaterThan(100);
    const hits: string[] = [];
    for (const file of files) {
      if (file.endsWith('schema.d.ts')) continue;
      if ((await readFile(file, 'utf8')).includes('DUPLICATE_APPROVER')) hits.push(file);
    }
    expect(hits).toEqual([]);
  });
});
