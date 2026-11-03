import { randomUUID } from 'node:crypto';
import request, { type Response } from 'supertest';
import { afterEach } from 'vitest';
import { createApiApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/passwords.js';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import { withTransaction } from '../../src/db/transaction.js';
import { CaptureMailer } from '../../src/mail/capture.js';
import { createMailDispatcher } from '../../src/mail/dispatcher.js';
import { issueToken, type TokenPurpose } from '../../src/tokens/one-time.js';
import { testApiConfig } from './api-config.js';
import { testClock, type TestClock } from './clock.js';
import { createTestDatabase, type TestDatabase } from './db.js';
import { createCapture } from './log-capture.js';
import { trackDatabase } from './setup.js';

// The real API app on a fresh database with a test clock, plus helpers to seed users and
// carry session cookies between requests (slice 1 account tests).

export const APP_ORIGIN = 'http://localhost:8080';
export const PASSWORD = 'correct horse battery staple';

const clients: AppPrismaClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.$disconnect()));
});

/** The session cookies a response set, by name; an empty value means cleared. */
export type CookieJar = Record<string, string>;

export function cookiesSet(res: Response): CookieJar {
  const jar: CookieJar = {};
  const header = res.get('Set-Cookie') ?? [];
  for (const cookie of header) {
    const [pair = ''] = cookie.split(';');
    const separator = pair.indexOf('=');
    jar[pair.slice(0, separator)] = decodeURIComponent(pair.slice(separator + 1));
  }
  return jar;
}

export function cookieHeader(jar: CookieJar, ...names: string[]): string {
  return names
    .filter((name) => jar[name])
    .map((name) => `${name}=${jar[name] ?? ''}`)
    .join('; ');
}

export interface SeededUser {
  id: string;
  email: string;
  name: string;
  password: string;
}

function instance(db: TestDatabase, clock: TestClock) {
  const prisma = createPrismaClient({
    url: db.url('po_app'),
    poolSize: 4,
    connectionTimeoutMs: 2_000,
  });
  clients.push(prisma);
  const capture = createCapture();
  const mailer = new CaptureMailer();
  const mail = createMailDispatcher(mailer);
  const app = createApiApp({
    config: testApiConfig({ DATABASE_URL: db.url('po_app'), APP_ORIGIN }),
    prisma,
    clock,
    logger: capture.logger,
    mail,
    expectedMigrations: [],
  });
  return { app, prisma, logs: capture.lines, mailer, mail };
}

export async function accountsHarness(start?: Date) {
  const db = trackDatabase(await createTestDatabase());
  const clock = testClock(start);
  const first = instance(db, clock);
  const admin = await db.client('postgres');

  /** A user seeded as the superuser (no audit); password null leaves none set. */
  async function seedUser(
    options: { roles?: string; status?: string; password?: string | null; name?: string } = {},
  ): Promise<SeededUser> {
    const id = randomUUID();
    const email = `${id.slice(0, 8)}@example.local`;
    const password = options.password === undefined ? PASSWORD : options.password;
    const name = options.name ?? 'Asha Rao';
    const status = options.status ?? 'ACTIVE';
    await admin.query('BEGIN');
    await admin.query('SET LOCAL session_replication_role = replica');
    await admin.query(
      `INSERT INTO users (id, name, email, roles, status, deactivated_at, password_hash)
       VALUES ($1, $2, $3, $4::text[], $5, CASE WHEN $5 = 'DEACTIVATED' THEN now() END, $6)`,
      [
        id,
        name,
        email,
        options.roles ?? '{BUYER}',
        status,
        password === null ? null : await hashPassword(password),
      ],
    );
    await admin.query('COMMIT');
    return { id, email, name, password: password ?? '' };
  }

  /** Issues a one-time token as the system, as the bootstrap or an email would. */
  function issue(userId: string, purpose: TokenPurpose = 'RESET'): Promise<string> {
    return withTransaction(
      {
        prisma: first.prisma,
        actor: { type: 'SYSTEM' },
        requestId: 'req-test-issue',
        timeoutMs: 5_000,
        maxWaitMs: 2_000,
      },
      async (tx) => (await issueToken(tx, userId, purpose)).token,
    );
  }

  function login(email: string, password: string, ip = '10.0.0.1', app = first.app) {
    return request(app)
      .post('/auth/login')
      .set('Origin', APP_ORIGIN)
      .set('X-Forwarded-For', ip)
      .send({ email, password });
  }

  /** Logs in and returns the cookies the session uses. */
  async function loggedIn(user: SeededUser): Promise<CookieJar> {
    const res = await login(user.email, user.password);
    if (res.status !== 200) throw new Error(`login failed: ${JSON.stringify(res.body)}`);
    return cookiesSet(res);
  }

  /** A refresh-cookie call (refresh, logout, logout-all) with the CSRF header. */
  function withRefresh(path: string, jar: CookieJar, app = first.app) {
    return request(app)
      .post(path)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookieHeader(jar, 'po_refresh', 'po_access'))
      .set('X-CSRF-Token', jar['po_csrf'] ?? '');
  }

  function get(path: string, jar: CookieJar, app = first.app) {
    return request(app).get(path).set('Cookie', cookieHeader(jar, 'po_access'));
  }

  /** A state-changing call with the access cookie and the CSRF header. */
  function send(
    method: 'post' | 'patch' | 'delete',
    path: string,
    jar: CookieJar,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const agent = request(first.app);
    let req = agent[method](path)
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookieHeader(jar, 'po_access'))
      .set('X-CSRF-Token', jar['po_csrf'] ?? '');
    for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
    return body === undefined ? req : req.send(body as object);
  }

  async function query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
    return (await admin.query<T>(sql, params)).rows;
  }

  return {
    db,
    clock,
    app: first.app,
    logs: first.logs,
    mailer: first.mailer,
    /** The mail sent so far, once every send started after commit has finished. */
    sentMail: async () => {
      await first.mail.settled();
      return first.mailer.sent;
    },
    post: (path: string, body: unknown, ip = '10.0.0.1') =>
      request(first.app)
        .post(path)
        .set('Origin', APP_ORIGIN)
        .set('X-Forwarded-For', ip)
        .send(body as object),
    /** A second API instance on the same database and clock. */
    secondInstance: () => instance(db, clock).app,
    seedUser,
    issue,
    login,
    loggedIn,
    withRefresh,
    get,
    send,
    query,
  };
}

export type AccountsHarness = Awaited<ReturnType<typeof accountsHarness>>;
