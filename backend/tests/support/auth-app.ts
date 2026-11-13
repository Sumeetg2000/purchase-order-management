import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach } from 'vitest';
import { createAccessTokens } from '../../src/auth/access-token.js';
import { csrfTokenFor } from '../../src/auth/csrf.js';
import { createAuthService } from '../../src/auth/service.js';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import type { RouteDefinition } from '../../src/http/define-route.js';
import { hashToken } from '../../src/tokens/one-time.js';
import { testClock } from './clock.js';
import { createTestDatabase } from './db.js';
import { testLogger } from './log-capture.js';
import { trackDatabase } from './setup.js';
import { createTestApp } from './test-app.js';

// An app with real authentication around test-only routes, and users seeded with a session
// each, for tests of the steps before a handler (authorize, CSRF, body parsing).

export const APP_ORIGIN = 'http://localhost:8080';
const JWT_KEY = Buffer.alloc(32, 1).toString('base64url');
const CSRF_SECRET = Buffer.alloc(32, 2).toString('base64url');

const clients: AppPrismaClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.$disconnect()));
});

export interface SeededSession {
  userId: string;
  access: string;
  csrf: string;
}

export async function authApp(testOnlyRoutes: readonly RouteDefinition[]) {
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
    testOnlyRoutes,
  });
  const admin = await db.client('postgres');

  /** An active user with these roles (a Postgres array literal) and one session. */
  async function seed(roles: string): Promise<SeededSession> {
    const userId = randomUUID();
    const sessionId = randomUUID();
    await admin.query('BEGIN');
    await admin.query('SET LOCAL session_replication_role = replica');
    await admin.query(
      `INSERT INTO users (id, name, email, roles, status)
       VALUES ($1, 'Auth User', $2, $3::text[], 'ACTIVE')`,
      [userId, `${userId}@example.local`, roles],
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
      [randomUUID(), sessionId, hashToken(randomBytes(32).toString('base64url'))],
    );
    await admin.query('COMMIT');
    return {
      userId,
      access: await accessTokens.sign({ userId, sessionId }),
      csrf: csrfTokenFor(CSRF_SECRET, sessionId),
    };
  }

  return { db, app, seed };
}

/** The headers of a logged-in, same-origin write; `csrf: false` leaves the token out. */
export function sessionHeaders(
  user: SeededSession,
  { csrf = true }: { csrf?: boolean } = {},
): Record<string, string> {
  return {
    Origin: APP_ORIGIN,
    Cookie: `po_access=${user.access}`,
    ...(csrf ? { 'X-CSRF-Token': user.csrf } : {}),
  };
}
