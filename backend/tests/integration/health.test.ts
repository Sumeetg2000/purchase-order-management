import { createServer } from 'node:net';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import { createApp } from '../../src/http/app.js';
import { healthRoutes, listMigrations } from '../../src/http/routes/health.js';
import { createTestDatabase } from '../support/db.js';
import { trackDatabase } from '../support/setup.js';

const clients: AppPrismaClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.$disconnect()));
});

function prismaFor(url: string): AppPrismaClient {
  const client = createPrismaClient({ url, poolSize: 2, connectionTimeoutMs: 1_000 });
  clients.push(client);
  return client;
}

/** A local port with nothing listening on it, so connections are refused. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

async function appFor(url: string, expectedMigrations?: readonly string[]) {
  return createApp({
    routes: healthRoutes({
      prisma: prismaFor(url),
      expectedMigrations: expectedMigrations ?? (await listMigrations()),
    }),
  });
}

describe('[NFR-OPS-02] health and readiness', () => {
  it('[NFR-OPS-02] /healthz returns 200 {status: "ok"}', async () => {
    const db = trackDatabase(await createTestDatabase());
    const res = await request(await appFor(db.url('po_app'))).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('[NFR-OPS-02] /readyz returns 200 with database and migrations ok', async () => {
    const db = trackDatabase(await createTestDatabase());
    const res = await request(await appFor(db.url('po_app'))).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready', checks: { database: 'ok', migrations: 'ok' } });
  });

  it('[NFR-OPS-02] with the database unreachable, /readyz is 503 SERVICE_UNAVAILABLE and /healthz stays 200', async () => {
    const url = `postgresql://po_app:unused-password@127.0.0.1:${String(await closedPort())}/po`;
    const app = await appFor(url);

    const ready = await request(app).get('/readyz');
    expect(ready.status).toBe(503);
    expect(ready.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(ready.body).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
    expect(JSON.stringify(ready.body)).not.toContain('unused-password');

    const health = await request(app).get('/healthz');
    expect(health.status).toBe(200);
  });

  it('[NFR-OPS-02] with a migration not yet applied, /readyz is 503', async () => {
    const db = trackDatabase(await createTestDatabase());
    const expected = [...(await listMigrations()), '9999_not_applied'];
    const res = await request(await appFor(db.url('po_app'), expected)).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('[NFR-OPS-02] with a failed migration recorded, /readyz is 503', async () => {
    const db = trackDatabase(await createTestDatabase());
    const owner = await db.client('po_owner');
    await owner.query(
      `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, applied_steps_count)
       VALUES ('failed-1', 'x', '0002_failed', now(), 0)`,
    );
    const res = await request(await appFor(db.url('po_app'))).get('/readyz');
    expect(res.status).toBe(503);
  });

  it('[NFR-OPS-02] lists the migrations shipped in prisma/migrations, in order', async () => {
    const names = await listMigrations();
    expect(names[0]).toBe('0001_baseline');
    expect([...names].sort()).toEqual(names);
  });

  it('[NFR-OPS-02] answers 503 within its deadline when the database stops responding', async () => {
    // A connection that is open but never answers, as in a network partition.
    const hung = { $queryRaw: () => new Promise(() => undefined) } as unknown as AppPrismaClient;
    const app = createApp({
      routes: healthRoutes({ prisma: hung, expectedMigrations: ['0001_baseline'], timeoutMs: 200 }),
    });
    const begun = Date.now();
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(Date.now() - begun).toBeLessThan(2_000);
  });
});
