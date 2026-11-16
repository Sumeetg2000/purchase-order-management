import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { listEntityHistory } from '../../src/audit/repository.js';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import { createTestDatabase } from '../support/db.js';
import { trackDatabase } from '../support/setup.js';

// An entity's history (vendor history, order timeline) is read in one statement, one
// snapshot: the page and the total always describe the same entries. Read in two parallel
// queries, an entry committed between them could show a total that its page disagrees with.

const clients: AppPrismaClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.$disconnect()));
});

async function setup() {
  const db = trackDatabase(await createTestDatabase());
  const prisma = createPrismaClient({
    url: db.url('po_app'),
    poolSize: 8,
    connectionTimeoutMs: 5_000,
  });
  clients.push(prisma);
  let queries = 0;
  const counted = new Proxy(prisma, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (
        (property === '$queryRaw' || property === '$queryRawUnsafe') &&
        typeof value === 'function'
      ) {
        return (...args: unknown[]) => {
          queries += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  });
  const writer = await db.client('po_app');
  const entityId = randomUUID();
  const append = async () => {
    await writer.query('BEGIN');
    await writer.query(`SELECT set_config('app.actor_txid', txid_current()::text, true)`);
    await writer.query(`SELECT set_config('app.actor_type', 'SYSTEM', true)`);
    await writer.query(
      `INSERT INTO audit_entries (action, entity_type, entity_id, details)
       VALUES ('VENDOR_UPDATED', 'vendor', $1, '{"n": 1}')`,
      [entityId],
    );
    await writer.query('COMMIT');
  };
  return {
    counted,
    append,
    entity: { entityType: 'vendor', entityId } as const,
    queries: () => queries,
  };
}

describe('[NFR-AUD-03] reading an entity history', () => {
  it('[NFR-AUD-03] the page and the total are read in one statement', async () => {
    const { counted, append, entity, queries } = await setup();
    await append();
    await append();
    const before = queries();
    const { rows, total } = await listEntityHistory(counted, entity, { offset: 0, limit: 20 });
    expect(queries() - before).toBe(1);
    expect(total).toBe(2);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      action: 'VENDOR_UPDATED',
      actorType: 'SYSTEM',
      details: { n: 1 },
    });
    expect(rows[0]?.occurredAt).toBeInstanceOf(Date);
    expect(Number(rows[0]?.id)).toBeGreaterThan(Number(rows[1]?.id));
  });

  it('[NFR-AUD-03] while entries are appended, every read has as many rows as its total says', async () => {
    const { counted, append, entity } = await setup();
    let writing = true;
    const writes = (async () => {
      for (let i = 0; i < 80; i += 1) await append();
      writing = false;
    })();
    const torn: string[] = [];
    const reads = Array.from({ length: 4 }, async () => {
      while (writing) {
        const { rows, total } = await listEntityHistory(counted, entity, { offset: 0, limit: 500 });
        if (rows.length !== total) torn.push(`${String(rows.length)} rows, total ${String(total)}`);
      }
    });
    await Promise.all([writes, ...reads]);
    expect(torn).toEqual([]);
  });
});
