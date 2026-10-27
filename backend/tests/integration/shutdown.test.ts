import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startApi } from '../../src/api.js';
import { createPrismaClient } from '../../src/db/client.js';
import { createTestApp } from '../support/test-app.js';
import { defineRoute } from '../../src/http/define-route.js';
import { createShutdown } from '../../src/http/shutdown.js';
import { createTestDatabase, type TestDatabase } from '../support/db.js';
import { trackDatabase } from '../support/setup.js';
import { testLogger } from '../support/log-capture.js';

const silent = pino({ level: 'silent' });

function get(port: number, path: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
  });
}

async function appConnections(db: TestDatabase): Promise<number> {
  const admin = await db.client('postgres');
  const result = await admin.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname = $1 AND usename = 'po_app'`,
    [db.name],
  );
  return Number(result.rows[0]?.count);
}

/** A server with one slow route whose completion the test controls. */
async function slowServer(db: TestDatabase) {
  const prisma = createPrismaClient({
    url: db.url('po_app'),
    poolSize: 2,
    connectionTimeoutMs: 1_000,
  });
  // Prisma connects lazily; open a pooled connection so closing it is observable.
  await prisma.$queryRaw`SELECT 1`;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));

  const app = createTestApp({
    logger: testLogger(),
    appOrigin: 'http://localhost:8080',
    testOnlyRoutes: [
      defineRoute({
        method: 'get',
        path: '/slow',
        operationId: 'testSlow',
        summary: 'test only',
        access: 'public',
        responses: { 200: z.object({ value: z.number() }) },
        handler: async (_req, res) => {
          entered();
          await released;
          // The pool must still work while the server drains.
          const rows = await prisma.$queryRaw<{ value: number }[]>`SELECT 1::int AS value`;
          res.json({ value: rows[0]?.value });
        },
      }),
    ],
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { prisma, server, port, started, release };
}

describe('[NFR-OPS-02] graceful shutdown', () => {
  it('[NFR-OPS-02] finishes in-flight requests, refuses new connections and closes the pool', async () => {
    const db = trackDatabase(await createTestDatabase());
    const { prisma, server, port, started, release } = await slowServer(db);

    const inFlight = get(port, '/slow');
    await started;
    expect(await appConnections(db)).toBeGreaterThan(0);

    const done = createShutdown({
      servers: [server],
      prisma,
      logger: silent,
      drainTimeoutMs: 5_000,
    })();

    await expect(get(port, '/slow')).rejects.toMatchObject({ code: 'ECONNREFUSED' });

    release();
    await expect(inFlight).resolves.toEqual({ status: 200, body: '{"value":1}' });
    await done;

    await expect.poll(() => appConnections(db), { timeout: 2_000 }).toBe(0);
  });

  it('[NFR-OPS-02] gives up on requests still running after the drain timeout', async () => {
    const db = trackDatabase(await createTestDatabase());
    const { prisma, server, port, started } = await slowServer(db);

    const stuck = get(port, '/slow');
    await started;

    const begun = Date.now();
    await createShutdown({ servers: [server], prisma, logger: silent, drainTimeoutMs: 200 })();
    expect(Date.now() - begun).toBeLessThan(3_000);
    await expect(stuck).rejects.toThrow();
    await expect.poll(() => appConnections(db), { timeout: 2_000 }).toBe(0);
  });

  it('[NFR-OPS-02] runs once even when signalled twice', async () => {
    const db = trackDatabase(await createTestDatabase());
    const { prisma, server } = await slowServer(db);
    const shutdown = createShutdown({
      servers: [server],
      prisma,
      logger: silent,
      drainTimeoutMs: 1_000,
    });
    const first = shutdown();
    expect(shutdown()).toBe(first);
    await first;
    expect(server.listening).toBe(false);
  });
});

describe('[NFR-OPS-02] a failed start', () => {
  async function listening(port: number) {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    return server;
  }
  async function freePort() {
    const server = await listening(0);
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    return port;
  }
  function accepts(port: number) {
    return new Promise<boolean>((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        resolve(false);
      });
    });
  }

  it('[NFR-OPS-02] closes the API listener when the metrics port is taken', async () => {
    const db = trackDatabase(await createTestDatabase());
    const taken = await listening(0);
    const httpPort = await freePort();
    try {
      await expect(
        startApi(
          {
            APP_ENV: 'local',
            APP_ORIGIN: 'http://localhost:8080',
            DATABASE_URL: db.url('po_app'),
            DB_POOL_SIZE: 2,
            DB_TX_TIMEOUT_MS: 5_000,
            DB_TX_MAX_WAIT_MS: 2_000,
            HTTP_PORT: httpPort,
            METRICS_PORT: (taken.address() as AddressInfo).port,
            LOG_LEVEL: 'error',
            SMTP_HOST: 'mailpit',
            SMTP_PORT: 1025,
            SMTP_SECURE: false,
            SMTP_USER: undefined,
            SMTP_PASSWORD: undefined,
            MAIL_FROM: 'noreply@example.local',
          },
          silent,
        ),
      ).rejects.toThrow();
      expect(await accepts(httpPort)).toBe(false);
    } finally {
      taken.close();
    }
  });
});
