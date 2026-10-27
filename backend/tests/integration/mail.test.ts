import { createServer as createHttpServer, get as httpGet } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startApi, type RunningApi } from '../../src/api.js';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import { withTransaction } from '../../src/db/transaction.js';
import { defineRoute } from '../../src/http/define-route.js';
import { requestIdOf } from '../../src/http/middleware/correlation.js';
import { createShutdown } from '../../src/http/shutdown.js';
import { CaptureMailer } from '../../src/mail/capture.js';
import { createMailDispatcher } from '../../src/mail/dispatcher.js';
import type { Mailer } from '../../src/mail/mailer.js';
import { sendAfterCommit } from '../../src/mail/send-after-commit.js';
import { createSmtpMailer } from '../../src/mail/smtp.js';
import { defineTemplate, InvalidRecipientError, renderMail } from '../../src/mail/template.js';
import { createTestDatabase } from '../support/db.js';
import { createCapture } from '../support/log-capture.js';
import { createLogger } from '../../src/observability/logger.js';
import { trackDatabase } from '../support/setup.js';
import { createTestApp } from '../support/test-app.js';
import { z } from 'zod';

// Slice 0 has no real templates (research R14): a test-only one, borrowing a slice 1
// template's name, proves the pipeline.
const greeting = defineTemplate<{ name: string }>({
  name: 'verify_email',
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

/**
 * A plain-text SMTP server that never offers STARTTLS but does offer AUTH, recording
 * every command it receives: what a man in the middle stripping STARTTLS looks like.
 */
async function plainTextSmtpServer(): Promise<{ port: number; commands: string[] }> {
  const commands: string[] = [];
  const server = createServer((socket) => {
    let inData = false;
    let buffered = '';
    socket.write('220 plain.test ESMTP\r\n');
    socket.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('latin1');
      let end = buffered.indexOf('\r\n');
      while (end !== -1) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        end = buffered.indexOf('\r\n');
        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 queued\r\n');
          }
          continue;
        }
        commands.push(line);
        const verb = line.split(' ')[0]?.toUpperCase();
        if (verb === 'EHLO') socket.write('250-plain.test\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (verb === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (verb === 'QUIT') socket.end('221 bye\r\n');
        else if (verb === 'AUTH') socket.write('235 accepted\r\n');
        else socket.write('250 ok\r\n');
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  );
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { port: address.port, commands };
}

async function setup(mailer: Mailer) {
  const mail = createMailDispatcher(mailer);
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
            mail,
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
  return { send, capture, mail };
}

describe('[NFR-OPS-04] mail is sent only after commit', () => {
  it('[NFR-OPS-04] a committed transaction sends exactly one message, with variables escaped in the HTML', async () => {
    const mailer = new CaptureMailer();
    const { send, mail } = await setup(mailer);
    expect((await send(false)).status).toBe(200);
    await mail.settled();
    expect(mailer.sent).toEqual([
      {
        template: 'verify_email',
        to: RECIPIENT,
        subject: 'Hello',
        text: 'Hello Asha <b>',
        html: '<p>Hello Asha &lt;b&gt;</p>',
      },
    ]);
  });

  it('[NFR-OPS-04] a rolled-back transaction sends nothing', async () => {
    const mailer = new CaptureMailer();
    const { send, mail } = await setup(mailer);
    expect((await send(true)).status).toBe(500);
    await mail.settled();
    expect(mailer.sent).toEqual([]);
  });

  it('[NFR-OPS-04] a send failure is a mail_send_failed security log line, and the request still succeeds', async () => {
    const failing: Mailer = { send: () => Promise.reject(new Error('SMTP refused the message')) };
    const { send, capture, mail } = await setup(failing);
    const res = await send(false);
    expect(res.status).toBe(200);
    await mail.settled();
    const events = capture.lines.filter((line) => line['security'] === true);
    expect(events).toEqual([
      expect.objectContaining({
        event: 'mail_send_failed',
        template: 'verify_email',
        requestId: res.headers['x-request-id'],
      }),
    ]);
    // The recipient's address is personal data and stays out of the log.
    expect(JSON.stringify(events)).not.toContain(RECIPIENT);
  });

  it.each([undefined, null, 'refused'])(
    '[NFR-OPS-04] a send rejected with %s is still a mail_send_failed security log line',
    async (reason) => {
      const capture = createCapture();
      // A mailer is foreign code: it can reject with anything, not only an Error.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      const mail = createMailDispatcher({ send: () => Promise.reject(reason) });
      mail.dispatch(
        { template: greeting, to: RECIPIENT, variables: { name: 'A' } },
        capture.logger,
      );
      await mail.settled();
      expect(capture.lines.filter((line) => line['security'] === true)).toEqual([
        expect.objectContaining({ event: 'mail_send_failed', template: 'verify_email' }),
      ]);
    },
  );

  it('[NFR-OPS-04] a mailer that throws instead of rejecting is still a mail_send_failed security log line', async () => {
    const capture = createCapture();
    const mail = createMailDispatcher({
      send: () => {
        throw new Error('template failed to render');
      },
    });
    expect(() => {
      mail.dispatch(
        { template: greeting, to: RECIPIENT, variables: { name: 'A' } },
        capture.logger,
      );
    }).not.toThrow();
    await mail.settled();
    expect(capture.lines.filter((line) => line['security'] === true)).toEqual([
      expect.objectContaining({ event: 'mail_send_failed', template: 'verify_email' }),
    ]);
  });

  it('[NFR-OPS-04] a logger that throws while recording a failure cannot make settling reject', async () => {
    const broken = createLogger('trace', {
      write: () => {
        throw new Error('log stream closed');
      },
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const mail = createMailDispatcher({ send: () => Promise.reject(new Error('refused')) });
      mail.dispatch({ template: greeting, to: RECIPIENT, variables: { name: 'A' } }, broken);
      await expect(mail.settle(1_000)).resolves.toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('[NFR-OPS-04] the response does not wait for the mail server', async () => {
    const gate: { open?: () => void } = {};
    const opened = new Promise<undefined>((resolve) => {
      gate.open = () => {
        resolve(undefined);
      };
    });
    const stalled = new CaptureMailer();
    const slow: Mailer = {
      send: async (message) => {
        await opened;
        await stalled.send(message);
      },
    };
    const { send, mail } = await setup(slow);
    const outcome = await Promise.race([
      send(false).then((res) => res.status),
      new Promise<string>((resolve) => {
        setTimeout(() => {
          resolve('still waiting on mail');
        }, 2_000);
      }),
    ]);
    expect(outcome).toBe(200);
    expect(stalled.sent).toEqual([]);
    gate.open?.();
    await mail.settled();
    expect(stalled.sent).toHaveLength(1);
  });

  it('[NFR-OPS-04] the SMTP mailer does not connect until it sends, and an unreachable server fails the send', async () => {
    const mailer = createSmtpMailer({
      APP_ENV: 'test',
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

  it('[NFR-OPS-04] in production, a server without TLS gets neither the credentials nor the message', async () => {
    const smtp = await plainTextSmtpServer();
    const mailer = createSmtpMailer({
      APP_ENV: 'production',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: smtp.port,
      SMTP_SECURE: false,
      SMTP_USER: 'mailer',
      SMTP_PASSWORD: 'not-a-real-password',
      MAIL_FROM: 'noreply@example.local',
    });
    await expect(
      mailer.send({ template: greeting, to: RECIPIENT, variables: { name: 'A' } }),
    ).rejects.toThrow();
    expect(smtp.commands.some((c) => /^EHLO /i.test(c))).toBe(true);
    expect(smtp.commands.filter((c) => /^(AUTH|MAIL|RCPT|DATA)\b/i.test(c))).toEqual([]);
  });

  it('[NFR-OPS-04] outside production, plain-text SMTP (the local Mailpit) still delivers', async () => {
    const smtp = await plainTextSmtpServer();
    const mailer = createSmtpMailer({
      APP_ENV: 'local',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: smtp.port,
      SMTP_SECURE: false,
      SMTP_USER: undefined,
      SMTP_PASSWORD: undefined,
      MAIL_FROM: 'noreply@example.local',
    });
    await mailer.send({ template: greeting, to: RECIPIENT, variables: { name: 'A' } });
    expect(smtp.commands).toContain('DATA');
  });
});

describe('[NFR-OPS-04] mail still sending at shutdown', () => {
  function delayedMailer(ms: number, sent: string[]): Mailer {
    return {
      send: (message) =>
        new Promise((resolve) => {
          setTimeout(() => {
            sent.push(message.template.name);
            resolve();
          }, ms);
        }),
    };
  }

  it('[NFR-OPS-04] shutdown waits for a send in flight before closing the pool', async () => {
    const order: string[] = [];
    const capture = createCapture();
    const mail = createMailDispatcher(delayedMailer(200, order));
    mail.dispatch({ template: greeting, to: RECIPIENT, variables: { name: 'A' } }, capture.logger);
    await createShutdown({
      servers: [],
      prisma: {
        $disconnect: () => {
          order.push('pool closed');
          return Promise.resolve();
        },
      },
      logger: capture.logger,
      drainTimeoutMs: 2_000,
      mail,
    })();
    expect(order).toEqual(['verify_email', 'pool closed']);
  });

  it('[NFR-OPS-04] settling also waits for a send dispatched while it waits', async () => {
    const sent: string[] = [];
    const capture = createCapture();
    const first = createMailDispatcher(delayedMailer(300, sent));
    first.dispatch({ template: greeting, to: RECIPIENT, variables: { name: 'A' } }, capture.logger);
    const settling = first.settle(2_000);
    // A request cut off by the drain can still commit and dispatch its mail.
    await new Promise((resolve) => setTimeout(resolve, 100));
    first.dispatch({ template: greeting, to: RECIPIENT, variables: { name: 'B' } }, capture.logger);
    await settling;
    expect(sent).toHaveLength(2);
  });

  it('[NFR-OPS-04] mail still gets time to finish when a stuck request used the whole drain', async () => {
    const sent: string[] = [];
    const capture = createCapture();
    const mail = createMailDispatcher(delayedMailer(500, sent));
    const stuck = createHttpServer(() => undefined);
    await new Promise<void>((resolve) => stuck.listen(0, '127.0.0.1', resolve));
    const { port } = stuck.address() as AddressInfo;
    httpGet({ host: '127.0.0.1', port, path: '/', agent: false }).on('error', () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    mail.dispatch({ template: greeting, to: RECIPIENT, variables: { name: 'A' } }, capture.logger);
    await createShutdown({
      servers: [stuck],
      prisma: { $disconnect: () => Promise.resolve() },
      logger: capture.logger,
      drainTimeoutMs: 1_200,
      mail,
      mailReserveMs: 1_000,
    })();
    expect(sent).toEqual(['verify_email']);
    expect(capture.lines.filter((line) => line['security'] === true)).toEqual([]);
  });

  it('[NFR-OPS-04] mail dispatched after shutdown settled is not sent but logged as mail_send_abandoned', async () => {
    const capture = createCapture();
    const send = vi.fn(() => Promise.resolve());
    const mail = createMailDispatcher({ send });
    await mail.settle(100);
    // A request cut off by the drain can commit after the mail wait has ended.
    mail.dispatch({ template: greeting, to: RECIPIENT, variables: { name: 'A' } }, capture.logger);
    await mail.settled();
    expect(send).not.toHaveBeenCalled();
    expect(capture.lines.filter((line) => line['security'] === true)).toEqual([
      expect.objectContaining({ event: 'mail_send_abandoned', template: 'verify_email' }),
    ]);
  });

  it('[NFR-OPS-04] a send still running when shutdown stops waiting is logged as mail_send_abandoned, since it may still be delivered', async () => {
    const capture = createCapture();
    const mail = createMailDispatcher(delayedMailer(5_000, []));
    mail.dispatch({ template: greeting, to: RECIPIENT, variables: { name: 'A' } }, capture.logger);
    const started = Date.now();
    await createShutdown({
      servers: [],
      prisma: { $disconnect: () => Promise.resolve() },
      logger: capture.logger,
      drainTimeoutMs: 300,
      mail,
    })();
    // The whole deadline, mail reserve included, is the 300 ms given.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(capture.lines.filter((line) => line['security'] === true)).toEqual([
      expect.objectContaining({
        event: 'mail_send_abandoned',
        template: 'verify_email',
      }),
    ]);
  });
});

describe('[NFR-OPS-04] recipients are plain addresses only', () => {
  // Defence in depth against address-parser bugs in mail libraries (nodemailer's
  // GHSA-8c8m-p3m8-cjg8, GHSA-m943-m63m-w62w, GHSA-85x2-q946-cp5h): a recipient must pass
  // the contracts' strict email schema before any mailer sees it.
  it.each([
    'a@x.com;b@y.com',
    '"x>"@a.com',
    'Asha <a@x.com>',
    'a@x.com (comment)',
    'a@x.com, b@y.com',
  ])('[NFR-OPS-04] %s is refused before the mailer is called', (to) => {
    const send = vi.fn(() => Promise.resolve());
    const scheduled: (() => unknown)[] = [];
    const hooks = { afterCommit: (callback: () => unknown) => scheduled.push(callback) };
    const message = { template: greeting, to, variables: { name: 'A' } };
    expect(() => {
      sendAfterCommit(hooks, {
        mail: createMailDispatcher({ send }),
        logger: createCapture().logger,
        message,
      });
    }).toThrow(InvalidRecipientError);
    expect(scheduled).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(() => renderMail(message)).toThrow(InvalidRecipientError);
  });

  it('[NFR-OPS-04] a plain address is accepted', () => {
    expect(
      renderMail({ template: greeting, to: 'asha.rao@example.co.in', variables: { name: 'A' } }).to,
    ).toBe('asha.rao@example.co.in');
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
