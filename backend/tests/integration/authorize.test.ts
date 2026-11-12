import { randomBytes, randomUUID } from 'node:crypto';
import { passwordSchema } from '@po/contracts';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAccessTokens } from '../../src/auth/access-token.js';
import { ACCESS_TOKEN_LIFETIME_SECONDS } from '../../src/auth/constants.js';
import { csrfTokenFor } from '../../src/auth/csrf.js';
import { createAuthService } from '../../src/auth/service.js';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import { RouteRegistrationError } from '../../src/http/app.js';
import { defineRoute, type RouteDefinition } from '../../src/http/define-route.js';
import { authOf, refreshSessionOf } from '../../src/http/middleware/authorize.js';
import { hashToken } from '../../src/tokens/one-time.js';
import { testClock } from '../support/clock.js';
import { createTestDatabase } from '../support/db.js';
import { testLogger } from '../support/log-capture.js';
import { trackDatabase } from '../support/setup.js';
import { createTestApp } from '../support/test-app.js';

// The authorize step (research R1, R7, R14; ADR-0004 precedence): 401, CSRF and
// NO_ROLE_ASSIGNED before validation; the access level's role check after it.

const APP_ORIGIN = 'http://localhost:8080';
const JWT_KEY = Buffer.alloc(32, 1).toString('base64url');
const CSRF_SECRET = Buffer.alloc(32, 2).toString('base64url');

const clients: AppPrismaClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.$disconnect()));
});

const echo = z.object({});

function route(
  method: 'get' | 'post' | 'patch',
  path: string,
  access: RouteDefinition['access'],
  extra: Partial<RouteDefinition> = {},
): RouteDefinition {
  return defineRoute({
    method,
    path,
    operationId: `test${method}${path.replaceAll(/[^a-z]/gi, '')}`,
    summary: 'test only',
    access,
    responses: { 200: echo },
    handler: (_req, res) => {
      res.json(
        access === 'public'
          ? {}
          : access === 'refresh'
            ? { session: refreshSessionOf(res).sessionId }
            : { ...authOf(res), input: res.locals['input'] as unknown },
      );
    },
    ...extra,
  });
}

const body = z.strictObject({ name: z.string().min(1) });

const ROUTES = [
  route('get', '/probe/open', 'public'),
  route('get', '/probe/me', 'user'),
  route('post', '/probe/me', 'user', { request: { body } }),
  route('post', '/probe/request', 'no-role', { request: { body } }),
  route('post', '/probe/admin', 'admin', { request: { body } }),
  route('post', '/probe/buyer', 'role', { roles: ['BUYER'], request: { body } }),
  route('get', '/probe/buyer-or-admin', 'role', { roles: ['BUYER', 'ADMIN'] }),
  route('post', '/probe/refresh', 'refresh'),
  route('patch', '/probe/versioned', 'admin', { ifMatch: 'required', request: { body } }),
  route('post', '/probe/password', 'user', {
    request: { body: z.strictObject({ password: passwordSchema }) },
  }),
];

interface Seeded {
  userId: string;
  sessionId: string;
  access: string;
  csrf: string;
  refresh: string;
}

async function setup() {
  const db = trackDatabase(await createTestDatabase());
  const clock = testClock();
  const prisma = createPrismaClient({
    url: db.url('po_app'),
    poolSize: 2,
    connectionTimeoutMs: 2_000,
  });
  clients.push(prisma);
  const accessTokens = createAccessTokens({ signingKey: JWT_KEY, keyId: 'k1', clock });
  const app = createTestApp({
    logger: testLogger(),
    appOrigin: APP_ORIGIN,
    auth: { service: createAuthService({ prisma, accessTokens, clock }), csrfSecret: CSRF_SECRET },
    testOnlyRoutes: ROUTES,
  });
  const admin = await db.client('postgres');

  /** A user with one session and its tokens, seeded as the superuser. */
  async function seed(roles: string, status = 'ACTIVE'): Promise<Seeded> {
    const userId = randomUUID();
    const sessionId = randomUUID();
    const refresh = randomBytes(32).toString('base64url');
    await admin.query('BEGIN');
    await admin.query('SET LOCAL session_replication_role = replica');
    await admin.query(
      `INSERT INTO users (id, name, email, roles, status, deactivated_at)
       VALUES ($1, 'Auth User', $2, $3::text[], $4, CASE WHEN $4 = 'DEACTIVATED' THEN now() END)`,
      [userId, `${userId}@example.local`, roles, status],
    );
    await admin.query(
      `INSERT INTO sessions (id, user_id, created_at, last_used_at, absolute_expires_at,
                             expires_at, user_agent, ip)
       VALUES ($1, $2, now(), now(), now() + interval '30 days', now() + interval '7 days',
               'agent', '10.0.0.1')`,
      [sessionId, userId],
    );
    await admin.query(
      `INSERT INTO refresh_tokens (id, session_id, token_hash, expires_at, created_at)
       VALUES ($1, $2, $3, now() + interval '7 days', now())`,
      [randomUUID(), sessionId, hashToken(refresh)],
    );
    await admin.query('COMMIT');
    return {
      userId,
      sessionId,
      refresh,
      access: await accessTokens.sign({ userId, sessionId }),
      csrf: csrfTokenFor(CSRF_SECRET, sessionId),
    };
  }

  return { db, app, clock, admin, seed };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function as(app: Setup['app'], user: Seeded) {
  return {
    get: (path: string) => request(app).get(path).set('Cookie', `po_access=${user.access}`),
    /** null sends no CSRF header. */
    post: (path: string, csrf: string | null = user.csrf) => {
      const req = request(app)
        .post(path)
        .set('Origin', APP_ORIGIN)
        .set('Cookie', `po_access=${user.access}`);
      return csrf === null ? req : req.set('X-CSRF-Token', csrf);
    },
  };
}

describe('[NFR-AUTH-01] authentication', () => {
  it('[NFR-AUTH-01] a public route needs no session', async () => {
    const { app } = await setup();
    expect((await request(app).get('/probe/open')).status).toBe(200);
  });

  it('[NFR-AUTH-01] no access cookie, or a malformed one, is 401 UNAUTHENTICATED', async () => {
    const { app } = await setup();
    for (const req of [
      request(app).get('/probe/me'),
      request(app).get('/probe/me').set('Cookie', 'po_access=not.a.jwt'),
    ]) {
      const res = await req;
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
    }
  });

  it('[NFR-SEC-03] an expired access token is 401 ACCESS_TOKEN_EXPIRED', async () => {
    const { app, clock, seed } = await setup();
    const user = await seed('{BUYER}');
    clock.advance(ACCESS_TOKEN_LIFETIME_SECONDS * 1_000);
    const res = await as(app, user).get('/probe/me');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'ACCESS_TOKEN_EXPIRED' });
  });

  it('[NFR-AUTH-01] a valid token for a user that does not exist is 401 UNAUTHENTICATED', async () => {
    const { app, seed, admin } = await setup();
    const user = await seed('{BUYER}');
    await admin.query('SET session_replication_role = replica');
    await admin.query('DELETE FROM refresh_tokens; DELETE FROM sessions; DELETE FROM users');
    const res = await as(app, user).get('/probe/me');
    expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('[SC-006] a deactivated user is refused on the very next request, with a valid token', async () => {
    const { app, seed } = await setup();
    const user = await seed('{BUYER}', 'DEACTIVATED');
    const res = await as(app, user).get('/probe/me');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'ACCOUNT_DEACTIVATED' });
  });

  it('[NFR-SEC-03] roles and status are read on every request, not from the token', async () => {
    const { app, seed, admin } = await setup();
    const user = await seed('{BUYER}');
    expect((await as(app, user).get('/probe/me')).body).toMatchObject({
      userId: user.userId,
      sessionId: user.sessionId,
      roles: ['BUYER'],
    });
    await admin.query('SET session_replication_role = replica');
    await admin.query(`UPDATE users SET roles = '{APPROVER}' WHERE id = $1`, [user.userId]);
    expect((await as(app, user).get('/probe/me')).body).toMatchObject({ roles: ['APPROVER'] });
  });
});

describe('[NFR-SEC-04] CSRF', () => {
  it('[NFR-SEC-04] a state-changing request without the CSRF header, or with a wrong one, is 403 CSRF_REJECTED', async () => {
    const { app, seed } = await setup();
    const user = await seed('{BUYER}');
    const other = await seed('{BUYER}');
    for (const csrf of [null, '', other.csrf, `${user.csrf}x`]) {
      const res = await as(app, user).post('/probe/me', csrf).send({ name: 'x' });
      expect(res.status, String(csrf)).toBe(403);
      expect(res.body).toMatchObject({ code: 'CSRF_REJECTED' });
    }
    expect((await as(app, user).post('/probe/me').send({ name: 'x' })).status).toBe(200);
  });

  it('[NFR-SEC-04] reads are exempt from the CSRF header', async () => {
    const { app, seed } = await setup();
    const user = await seed('{BUYER}');
    expect((await as(app, user).get('/probe/me')).status).toBe(200);
  });

  it('[NFR-SEC-04] a cross-origin request is refused before anything else', async () => {
    const { app, seed } = await setup();
    const user = await seed('{BUYER}');
    const res = await as(app, user)
      .post('/probe/me')
      .set('Origin', 'https://evil.example')
      .send({ name: 'x' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'CSRF_REJECTED' });
  });

  it('[NFR-AUTH-01] no session beats a bad body: malformed JSON or the wrong media type is 401', async () => {
    const { app } = await setup();
    for (const req of [
      request(app)
        .post('/probe/me')
        .set('Origin', APP_ORIGIN)
        .set('Content-Type', 'application/json')
        .send('{"name":'),
      request(app)
        .post('/probe/me')
        .set('Origin', APP_ORIGIN)
        .set('Content-Type', 'text/plain')
        .send('x'),
    ]) {
      const res = await req;
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
    }
  });

  it('[NFR-AUTH-01] no session beats a missing CSRF header: 401, not 403', async () => {
    const { app } = await setup();
    const res = await request(app).post('/probe/me').set('Origin', APP_ORIGIN).send({ name: 'x' });
    expect(res.status).toBe(401);
  });
});

describe('[NFR-AUTH-02] access levels and check precedence', () => {
  it('[FR-ACC-08] a no-role user gets 403 NO_ROLE_ASSIGNED on a role route, before body validation', async () => {
    const { app, seed } = await setup();
    const user = await seed('{}');
    for (const sent of [{ name: 'x' }, { wrong: true }, '{"name":']) {
      const res = await as(app, user)
        .post('/probe/admin')
        .set('Content-Type', 'application/json')
        .send(sent);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'NO_ROLE_ASSIGNED' });
    }
  });

  it("[NFR-AUTH-02] a user without the route's role gets 403 FORBIDDEN, before body validation", async () => {
    const { app, seed } = await setup();
    const buyer = await seed('{BUYER}');
    for (const sent of [{ name: 'x' }, { wrong: true }, '{"name":']) {
      const res = await as(app, buyer)
        .post('/probe/admin')
        .set('Content-Type', 'application/json')
        .send(sent);
      expect(res.status, JSON.stringify(sent)).toBe(403);
      expect(res.body).toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('[NFR-AUTH-02] an Admin passes an admin route', async () => {
    const { app, seed } = await setup();
    const admin = await seed('{ADMIN}');
    expect((await as(app, admin).post('/probe/admin').send({ name: 'x' })).status).toBe(200);
  });

  it('[FR-ACC-08] a no-role route is for users with no role; anyone with a role gets 403 FORBIDDEN', async () => {
    const { app, seed } = await setup();
    const none = await seed('{}');
    const buyer = await seed('{BUYER}');
    expect((await as(app, none).post('/probe/request').send({ name: 'x' })).status).toBe(200);
    for (const sent of [{ name: 'x' }, { wrong: true }]) {
      const res = await as(app, buyer).post('/probe/request').send(sent);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('[FR-ACC-08] a user route serves users with and without a role', async () => {
    const { app, seed } = await setup();
    for (const roles of ['{}', '{BUYER}', '{ADMIN}']) {
      expect((await as(app, await seed(roles)).get('/probe/me')).status, roles).toBe(200);
    }
  });

  it('[NFR-AUTH-01] a non-public route on an app with no authenticator fails at startup', () => {
    expect(() =>
      createTestApp({
        logger: testLogger(),
        appOrigin: APP_ORIGIN,
        testOnlyRoutes: [route('get', '/probe/me', 'user')],
      }),
    ).toThrow(RouteRegistrationError);
  });
});

describe('[FR-ACT-01] the role access level', () => {
  const sent = [{ name: 'x' }, { wrong: true }, '{"name":'];

  it('[FR-ACT-01] a role route serves exactly its roles, a dual-role user included', async () => {
    const { app, seed } = await setup();
    for (const roles of ['{BUYER}', '{BUYER,APPROVER}']) {
      const res = await as(app, await seed(roles))
        .post('/probe/buyer')
        .send({ name: 'x' });
      expect(res.status, roles).toBe(200);
    }
    for (const roles of ['{BUYER}', '{ADMIN}']) {
      expect((await as(app, await seed(roles)).get('/probe/buyer-or-admin')).status, roles).toBe(
        200,
      );
    }
  });

  it('[FR-ACT-01] no role is 403 NO_ROLE_ASSIGNED, before body validation', async () => {
    const { app, seed } = await setup();
    const none = await seed('{}');
    for (const body of sent) {
      const res = await as(app, none)
        .post('/probe/buyer')
        .set('Content-Type', 'application/json')
        .send(body);
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect(res.body).toMatchObject({ code: 'NO_ROLE_ASSIGNED' });
    }
    expect((await as(app, none).get('/probe/buyer-or-admin')).body).toMatchObject({
      code: 'NO_ROLE_ASSIGNED',
    });
  });

  it('[FR-ACT-01] a role outside the list is 403 FORBIDDEN, before body validation', async () => {
    const { app, seed } = await setup();
    for (const roles of ['{APPROVER}', '{ADMIN}']) {
      const user = await seed(roles);
      for (const body of sent) {
        const res = await as(app, user)
          .post('/probe/buyer')
          .set('Content-Type', 'application/json')
          .send(body);
        expect(res.status, `${roles} ${JSON.stringify(body)}`).toBe(403);
        expect(res.body).toMatchObject({ code: 'FORBIDDEN' });
      }
    }
    const approver = await seed('{APPROVER}');
    expect((await as(app, approver).get('/probe/buyer-or-admin')).body).toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('[FR-ACT-01] an anonymous caller is 401 UNAUTHENTICATED', async () => {
    const { app } = await setup();
    const res = await request(app)
      .post('/probe/buyer')
      .set('Origin', APP_ORIGIN)
      .send({ wrong: true });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('[FR-ACT-01] a route whose access and roles disagree fails at startup', () => {
    const auth = {
      service: {} as never,
      csrfSecret: CSRF_SECRET,
    };
    for (const bad of [
      route('get', '/probe/bad', 'role'),
      route('get', '/probe/bad', 'role', { roles: [] }),
      route('get', '/probe/bad', 'admin', { roles: ['ADMIN'] }),
    ]) {
      expect(
        () =>
          createTestApp({
            logger: testLogger(),
            appOrigin: APP_ORIGIN,
            auth,
            testOnlyRoutes: [bad],
          }),
        JSON.stringify({ access: bad.access, roles: bad.roles }),
      ).toThrow(RouteRegistrationError);
    }
  });
});

describe('[NFR-SEC-02] refresh-cookie routes', () => {
  function refreshCall(app: Setup['app'], token: string | undefined, csrf: string | undefined) {
    let req = request(app).post('/probe/refresh').set('Origin', APP_ORIGIN);
    if (token !== undefined) req = req.set('Cookie', `po_refresh=${token}`);
    if (csrf !== undefined) req = req.set('X-CSRF-Token', csrf);
    return req;
  }

  it('[NFR-SEC-02] no refresh cookie is 401 UNAUTHENTICATED', async () => {
    const { app } = await setup();
    expect((await refreshCall(app, undefined, 'x')).body).toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('[NFR-SEC-02] an unknown refresh token is 401 SESSION_EXPIRED', async () => {
    const { app } = await setup();
    const res = await refreshCall(app, randomBytes(32).toString('base64url'), 'x');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'SESSION_EXPIRED' });
  });

  it("[NFR-SEC-04] the CSRF header must match the refresh token's session", async () => {
    const { app, seed } = await setup();
    const user = await seed('{BUYER}');
    const other = await seed('{BUYER}');
    for (const csrf of [undefined, other.csrf]) {
      expect((await refreshCall(app, user.refresh, csrf)).body).toMatchObject({
        code: 'CSRF_REJECTED',
      });
    }
    const res = await refreshCall(app, user.refresh, user.csrf);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ session: user.sessionId });
  });

  it('[NFR-SEC-02] an expired access cookie does not matter on a refresh route', async () => {
    const { app, seed, clock } = await setup();
    const user = await seed('{BUYER}');
    clock.advance(ACCESS_TOKEN_LIFETIME_SECONDS * 1_000);
    const res = await refreshCall(app, user.refresh, user.csrf).set(
      'Cookie',
      `po_refresh=${user.refresh}; po_access=${user.access}`,
    );
    expect(res.status).toBe(200);
  });
});

describe('[FR-ADM-02] If-Match and custom field codes', () => {
  async function versioned(ifMatch: string | undefined) {
    const { app, seed } = await setup();
    const admin = await seed('{ADMIN}');
    const req = request(app)
      .patch('/probe/versioned')
      .set('Origin', APP_ORIGIN)
      .set('Cookie', `po_access=${admin.access}`)
      .set('X-CSRF-Token', admin.csrf);
    return (ifMatch === undefined ? req : req.set('If-Match', ifMatch)).send({ name: 'x' });
  }

  it('[FR-ADM-02] a missing If-Match is 400 with VERSION_REQUIRED at header.if-match', async () => {
    const res = await versioned(undefined);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'header.if-match', code: 'VERSION_REQUIRED' }],
    });
  });

  it('[FR-ADM-02] an If-Match that is not a quoted version is INVALID_FORMAT', async () => {
    // Beyond PostgreSQL's integer range, a version can't exist.
    for (const value of ['3', '"0"', '"x"', 'W/"3"', '"2147483648"', '"99999999999999999999999"']) {
      expect((await versioned(value)).body, value).toMatchObject({
        details: [{ path: 'header.if-match', code: 'INVALID_FORMAT' }],
      });
    }
  });

  it('[FR-ADM-02] a quoted version reaches the handler as a number', async () => {
    const res = await versioned('"3"');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ input: { version: 3 } });
  });

  it('[FR-ACC-04] a password failure reports its own field code, not INVALID_FORMAT', async () => {
    const { app, seed } = await setup();
    const user = await seed('{BUYER}');
    const res = await as(app, user).post('/probe/password').send({ password: 'short' });
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'body.password', code: 'PASSWORD_TOO_SHORT' }],
    });
  });
});
