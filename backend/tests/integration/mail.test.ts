import { createServer } from 'node:net';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { startApi, type RunningApi } from '../../src/api.js';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import { withTransaction } from '../../src/db/transaction.js';
import { defineRoute } from '../../src/http/define-route.js';
import { requestIdOf } from '../../src/http/middleware/correlation.js';
import { CaptureMailer } from '../../src/mail/capture.js';
import type { Mailer } from '../../src/mail/mailer.js';
import { sendAfterCommit } from '../../src/mail/send-after-commit.js';
import { createSmtpMailer } from '../../src/mail/smtp.js';
import { defineTemplate } from '../../src/mail/template.js';
import { createTestDatabase } from '../support/db.js';
import { createCapture } from '../support/log-capture.js';
import { trackDatabase } from '../support/setup.js';
import { createTestApp } from '../support/test-app.js';
import { z } from 'zod';

// Slice 0 has no real templates (research R14): a test-only one proves the pipeline.
const greeting = defineTemplate<{ name: string }>({
  name: 'test_greeting',
  subject: () => 'Hello',
  text: ({ name }) => `Hello ${name}`,
  html: ({ name }) => `<p>Hello ${name}</p>`,
});

const RECIPIENT = 'someone@example.local';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

async function setup(mailer: Mailer) {
  const db = trackDatabase(await createTestDatabase());
  const prisma: AppPrismaClient = createPrismaClient({
    url: db.url('po_app'),
    poolSize: 2,
    connectionTimeoutMs: 2_000,
  });
  cleanups.push(() => prisma.$disconnect());
  const capture = createCapture();
  const route = defineRoute({
    method: 'post',
    path: '/test-mail',
    operationId: 'testSendMail',
    summary: 'test only',
    access: 'public',
    request: { body: z.strictObject({ rollback: z.boolean() }) },
    responses: { 200: z.object({ ok: z.boolean() }) },
    handler: async (req, res) => {
      const { rollback } = req.body as { rollback: boolean };
      await withTransaction(
        {
          prisma,
          actor: { type: 'SYSTEM' },
          requestId: requestIdOf(res),
          timeoutMs: 5_000,
          maxWaitMs: 2_000,
          logger: req.log,
        },
        (_tx, hooks) => {
          sendAfterCommit(hooks, {
            mailer,
            logger: req.log,
            message: { template: greeting, to: RECIPIENT, variables: { name: 'Asha <b>' } },
          });
          if (rollback) throw new Error('rolled back on purpose');
          return Promise.resolve();
        },
      );
      res.json({ ok: true });
    },
  });
  const app = createTestApp({
    logger: capture.logger,
    appOrigin: 'http://localhost:8080',
    testOnlyRoutes: [route],
  });
  const send = (rollback: boolean) =>
    request(app).post('/test-mail').set('Origin', 'http://localhost:8080').send({ rollback });
  return { send, capture };
}

describe('[NFR-OPS-04] mail is sent only after commit', () => {
  it('[NFR-OPS-04] a committed transaction sends exactly one message, with variables escaped in the HTML', async () => {
    const mailer = new CaptureMailer();
    const { send } = await setup(mailer);
    expect((await send(false)).status).toBe(200);
    expect(mailer.sent).toEqual([
      {
        template: 'test_greeting',
        to: RECIPIENT,
        subject: 'Hello',
        text: 'Hello Asha <b>',
        html: '<p>Hello Asha &lt;b&gt;</p>',
      },
    ]);
  });

  it('[NFR-OPS-04] a rolled-back transaction sends nothing', async () => {
    const mailer = new CaptureMailer();
    const { send } = await setup(mailer);
    expect((await send(true)).status).toBe(500);
    expect(mailer.sent).toEqual([]);
  });

  it('[NFR-OPS-04] a send failure is a mail_send_failed security log line, and the request still succeeds', async () => {
    const failing: Mailer = { send: () => Promise.reject(new Error('SMTP refused the message')) };
    const { send, capture } = await setup(failing);
    const res = await send(false);
    expect(res.status).toBe(200);
    const events = capture.lines.filter((line) => line['security'] === true);
    expect(events).toEqual([
      expect.objectContaining({
        event: 'mail_send_failed',
        template: 'test_greeting',
        requestId: res.headers['x-request-id'],
      }),
    ]);
    // The recipient's address is personal data and stays out of the log.
    expect(JSON.stringify(events)).not.toContain(RECIPIENT);
  });

  it('[NFR-OPS-04] the SMTP mailer does not connect until it sends, and an unreachable server fails the send', async () => {
    const mailer = createSmtpMailer({
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: await closedPort(),
      SMTP_SECURE: false,
      SMTP_USER: undefined,
      SMTP_PASSWORD: undefined,
      MAIL_FROM: 'noreply@example.local',
    });
    await expect(
      mailer.send({ template: greeting, to: RECIPIENT, variables: { name: 'A' } }),
    ).rejects.toThrow();
  });
});

describe('[NFR-OPS-04] startup with an unreachable mail server', () => {
  it('[NFR-OPS-04] the API starts and passes readiness while the SMTP host is unreachable', async () => {
    const db = trackDatabase(await createTestDatabase());
    const api: RunningApi = await startApi(
      {
        APP_ENV: 'local',
        APP_ORIGIN: 'http://localhost:8080',
        DATABASE_URL: db.url('po_app'),
        DB_POOL_SIZE: 2,
        DB_TX_TIMEOUT_MS: 5_000,
        DB_TX_MAX_WAIT_MS: 2_000,
        HTTP_PORT: 0,
        METRICS_PORT: 0,
        LOG_LEVEL: 'error',
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: await closedPort(),
        SMTP_SECURE: false,
        SMTP_USER: undefined,
        SMTP_PASSWORD: undefined,
        MAIL_FROM: 'noreply@example.local',
      },
      createCapture().logger,
    );
    cleanups.push(() => api.close());
    const res = await request(`http://127.0.0.1:${String(api.port)}`).get('/readyz');
    expect(res.status).toBe(200);
  });
});
