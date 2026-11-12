import { describe, expect, it } from 'vitest';
import { createAccessTokens } from '../../src/auth/access-token.js';
import { LOCKOUT_THRESHOLD, REFRESH_TOKEN_IDLE_SECONDS } from '../../src/auth/constants.js';
import { createSessionService } from '../../src/auth/service.js';
import { createPrismaClient } from '../../src/db/client.js';
import { createTransactionRunner } from '../../src/db/transaction.js';
import { SECOND_MS } from '../../src/lib/time.js';
import { RATE_LIMIT_BUCKETS } from '../../src/rate-limit/buckets.js';
import { createRateLimiter } from '../../src/rate-limit/service.js';
import { testLogger } from '../support/log-capture.js';
import {
  accountsHarness,
  PASSWORD,
  type AccountsHarness,
  type CookieJar,
} from '../support/accounts.js';

// Change password and the caller's sessions (ADR-0017 "Passwords", "Session management";
// spec US4 scenarios 3–7).

const NEW_PASSWORD = 'a brand new passphrase';
const UNKNOWN_ID = '0190a6a0-0000-7000-8000-000000000000';

function changePassword(h: AccountsHarness, jar: CookieJar, body: unknown) {
  return h.send('post', '/auth/change-password', jar, body);
}

function cleared(header: string[] | undefined): string[] {
  return (header ?? [])
    .filter((c) => /Expires=Thu, 01 Jan 1970/.test(c))
    .map((c) => c.split('=')[0] ?? '')
    .sort();
}

describe('[FR-ACC-04] change password', () => {
  it('[FR-ACC-04] sets the new password: the old one stops working', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const jar = await h.loggedIn(user);
    const res = await changePassword(h, jar, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(res.status).toBe(204);
    expect((await h.login(user.email, PASSWORD)).body).toMatchObject({
      code: 'INCORRECT_PASSWORD',
    });
    expect((await h.login(user.email, NEW_PASSWORD)).status).toBe(200);
  });

  it('[FR-ACC-04] ends every other session with PASSWORD_CHANGED and keeps this one', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const here = await h.loggedIn(user);
    const there = await h.loggedIn(user);
    await changePassword(h, here, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect((await h.get('/me', here)).status).toBe(200);
    expect((await h.withRefresh('/auth/refresh', here)).status).toBe(204);
    const other = await h.get('/me', there);
    expect(other.status).toBe(401);
    expect(other.body).toMatchObject({ code: 'SESSION_REVOKED', reason: 'PASSWORD_CHANGED' });
    expect(await h.query('SELECT revoke_reason FROM sessions ORDER BY created_at, id')).toEqual(
      expect.arrayContaining([{ revoke_reason: null }, { revoke_reason: 'PASSWORD_CHANGED' }]),
    );
  });

  it('[FR-ACC-04] a wrong current password is 400 with field INCORRECT_PASSWORD', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const jar = await h.loggedIn(user);
    const res = await changePassword(h, jar, {
      currentPassword: 'not my password',
      newPassword: NEW_PASSWORD,
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'body.currentPassword', code: 'INCORRECT_PASSWORD' }],
    });
    expect((await h.login(user.email, PASSWORD)).status).toBe(200);
  });

  it('[FR-ACC-04] wrong current passwords count toward the lockout, like login', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const jar = await h.loggedIn(user);
    const wrong = () =>
      changePassword(h, jar, { currentPassword: 'not my password', newPassword: NEW_PASSWORD });
    for (let i = 1; i < LOCKOUT_THRESHOLD; i += 1) expect((await wrong()).status).toBe(400);
    const locked = await wrong();
    expect(locked.status).toBe(423);
    expect(locked.body).toMatchObject({ code: 'ACCOUNT_LOCKED' });
    expect(Number(locked.get('Retry-After'))).toBeGreaterThan(0);
    // Locked: even the right current password is refused, and so is login.
    const right = await changePassword(h, jar, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(right.status).toBe(423);
    expect((await h.login(user.email, PASSWORD)).status).toBe(423);
  });

  it('[FR-ACC-04] a success clears earlier wrong guesses', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const jar = await h.loggedIn(user);
    const count = () => h.query('SELECT failed_login_count FROM users WHERE id = $1', [user.id]);
    await changePassword(h, jar, { currentPassword: 'not my password', newPassword: NEW_PASSWORD });
    expect(await count()).toEqual([{ failed_login_count: 1 }]);
    await changePassword(h, jar, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(await count()).toEqual([{ failed_login_count: 0 }]);
  });

  it.each([
    ['a too short', 'short pass', 'PASSWORD_TOO_SHORT'],
    ['a too long', 'p'.repeat(129), 'PASSWORD_TOO_LONG'],
    ['a common', 'password1234', 'PASSWORD_TOO_COMMON'],
  ])(
    '[FR-ACC-04] %s new password gets its field code, and nothing changes',
    async (_label, newPassword, code) => {
      const h = await accountsHarness();
      const user = await h.seedUser();
      const jar = await h.loggedIn(user);
      const res = await changePassword(h, jar, { currentPassword: PASSWORD, newPassword });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ details: [{ path: 'body.newPassword', code }] });
      expect((await h.login(user.email, PASSWORD)).status).toBe(200);
    },
  );

  it('[FR-ACC-04] a new password equal to the current one is 400 PASSWORD_UNCHANGED, and nothing is written', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const here = await h.loggedIn(user);
    const there = await h.loggedIn(user);
    // An earlier wrong guess stays counted: an unchanged password writes nothing.
    await changePassword(h, here, { currentPassword: 'not my password', newPassword: PASSWORD });
    const before = await h.query(
      'SELECT password_hash, updated_at, version, failed_login_count FROM users WHERE id = $1',
      [user.id],
    );
    const res = await changePassword(h, here, { currentPassword: PASSWORD, newPassword: PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'body.newPassword', code: 'PASSWORD_UNCHANGED' }],
    });
    expect(
      await h.query(
        'SELECT password_hash, updated_at, version, failed_login_count FROM users WHERE id = $1',
        [user.id],
      ),
    ).toEqual(before);
    expect(
      await h.query('SELECT count(*)::int AS n FROM sessions WHERE revoked_at IS NOT NULL'),
    ).toEqual([{ n: 0 }]);
    expect((await h.get('/me', there)).status).toBe(200);
  });

  it('[FR-ACC-04] a wrong current password with an equal new one is still INCORRECT_PASSWORD', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const jar = await h.loggedIn(user);
    const res = await changePassword(h, jar, {
      currentPassword: 'not my password',
      newPassword: 'not my password',
    });
    expect(res.body).toMatchObject({
      details: [{ path: 'body.currentPassword', code: 'INCORRECT_PASSWORD' }],
    });
  });

  it('[FR-ACC-04] shares the per-account rate limit with login: the next call is 429', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const jar = await h.loggedIn(user); // one login-account hit
    const limit = RATE_LIMIT_BUCKETS.find((b) => b.name === 'login-account')?.limit ?? 0;
    const wrong = { currentPassword: 'not my password', newPassword: NEW_PASSWORD };
    // Each wrong guess is forgotten (as the superuser, outside the audit), so only the rate
    // limit can refuse.
    await h.query('SET session_replication_role = replica');
    for (let hit = 2; hit <= limit; hit += 1) {
      const res = await changePassword(h, jar, wrong);
      expect(res.status, `hit ${String(hit)}`).not.toBe(429);
      await h.query('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [
        user.id,
      ]);
    }
    const over = await changePassword(h, jar, wrong);
    expect(over.status).toBe(429);
    expect(over.body).toMatchObject({ code: 'RATE_LIMITED' });
    expect(Number(over.get('Retry-After'))).toBeGreaterThan(0);
    expect((await h.login(user.email, PASSWORD)).status).toBe(429);
  });

  it.each([
    [
      // A reset or logout-all landed after the authorize step read the session.
      'revoked',
      `UPDATE sessions SET revoked_at = now(), revoke_reason = 'PASSWORD_RESET'`,
      { code: 'SESSION_REVOKED', reason: 'PASSWORD_RESET' },
    ],
    [
      // The purge removed it: no session row stands behind the token any more.
      'purged',
      'DELETE FROM refresh_tokens; DELETE FROM sessions',
      { code: 'SESSION_EXPIRED' },
    ],
  ])(
    '[FR-ACC-04] a session %s while the change runs is refused, and the password stays',
    async (_change, sql, refusal) => {
      const h = await accountsHarness();
      const user = await h.seedUser();
      await h.loggedIn(user);
      const [row] = await h.query<{ id: string }>('SELECT id::text FROM sessions');
      await h.query('SET session_replication_role = replica');
      await h.query(sql);
      const prisma = createPrismaClient({
        url: h.db.url('po_app'),
        poolSize: 2,
        connectionTimeoutMs: 2_000,
      });
      try {
        const sessions = createSessionService({
          prisma,
          transactions: createTransactionRunner({ prisma, timeoutMs: 5_000, maxWaitMs: 2_000 }),
          accessTokens: createAccessTokens({
            signingKey: Buffer.alloc(32, 1).toString('base64url'),
            keyId: 'test-1',
            clock: h.clock,
          }),
          rateLimiter: createRateLimiter({ prisma, clock: h.clock }),
          clock: h.clock,
          csrfSecret: Buffer.alloc(32, 2).toString('base64url'),
        });
        const stale = {
          userId: user.id,
          sessionId: row?.id ?? '',
          name: user.name,
          email: user.email,
          roles: ['BUYER' as const],
        };
        await expect(
          sessions.changePassword(
            stale,
            { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
            { requestId: 'req-race', logger: testLogger(), ip: '10.0.0.1', userAgent: 'test' },
          ),
        ).rejects.toMatchObject(refusal);
      } finally {
        await prisma.$disconnect();
      }
      expect((await h.login(user.email, PASSWORD)).status).toBe(200);
    },
  );

  it('[FR-ACC-04] needs the CSRF header', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const jar = await h.loggedIn(user);
    const res = await changePassword(
      h,
      { ...jar, po_csrf: 'forged' },
      {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      },
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'CSRF_REJECTED' });
  });

  it('[NFR-SEC-06] logs password_changed, and a wrong guess as password_change_failed, never a password', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const jar = await h.loggedIn(user);
    await changePassword(h, jar, { currentPassword: 'not my password', newPassword: NEW_PASSWORD });
    await changePassword(h, jar, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    const events = h.logs.map((line) => line['event']);
    expect(events).toContain('password_change_failed');
    expect(events).toContain('password_changed');
    const text = JSON.stringify(h.logs);
    expect(text).not.toContain(NEW_PASSWORD);
    expect(text).not.toContain('not my password');
  });
});

describe('[FR-ACC-06] session list', () => {
  it("[FR-ACC-06] lists only the caller's live sessions, newest use first, marking this one", async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const other = await h.seedUser();
    const older = await h.loggedIn(user);
    h.clock.advance(60_000);
    const newer = await h.loggedIn(user);
    await h.loggedIn(other);
    const ended = await h.loggedIn(user);
    await h.withRefresh('/auth/logout', ended);
    const res = await h.get('/auth/sessions', older);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 1, pageSize: 20, total: 2 });
    const items = (res.body as { items: Record<string, unknown>[] }).items;
    expect(items).toEqual([
      {
        id: expect.any(String) as unknown,
        createdAt: h.clock.now().toISOString(),
        lastUsedAt: h.clock.now().toISOString(),
        userAgent: expect.any(String) as unknown,
        ip: '10.0.0.1',
        current: false,
      },
      expect.objectContaining({ current: true }),
    ]);
    expect((await h.get('/auth/sessions', newer)).body).toMatchObject({
      items: [{ current: true }, { current: false }],
    });
  });

  it('[FR-ACC-06] leaves out a session past its expiry, and revoking it is 404', async () => {
    // A session's idle expiry never passes its absolute one (sessions_expiry_within_absolute),
    // so an expired session is past expires_at either way.
    const h = await accountsHarness();
    const user = await h.seedUser();
    const expired = (await sessionIds(h, await h.loggedIn(user)))[0];
    expect(expired?.id).toEqual(expect.any(String));
    h.clock.advance((REFRESH_TOKEN_IDLE_SECONDS + 60) * SECOND_MS);
    const jar = await h.loggedIn(user);
    expect(await sessionIds(h, jar)).toEqual([expect.objectContaining({ current: true })]);
    const res = await h.send('delete', `/auth/sessions/${expired?.id ?? ''}`, jar);
    expect(res.status).toBe(404);
  });

  it('[FR-ACC-06] is paginated', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const jar = await h.loggedIn(user);
    await h.loggedIn(user);
    await h.loggedIn(user);
    const res = await h.get('/auth/sessions?pageSize=2&page=2', jar);
    expect(res.body).toMatchObject({ page: 2, pageSize: 2, total: 3 });
    expect((res.body as { items: unknown[] }).items).toHaveLength(1);
  });
});

/** The id of a session, as the caller's list shows it. */
async function sessionIds(h: AccountsHarness, jar: CookieJar) {
  const res = await h.get('/auth/sessions', jar);
  return (res.body as { items: { id: string; current: boolean }[] }).items;
}

describe('[FR-ACC-06] revoke a session', () => {
  it('[FR-ACC-06] ends another session as USER_REVOKED; its next refresh gets no reason', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const here = await h.loggedIn(user);
    const there = await h.loggedIn(user);
    const target = (await sessionIds(h, here)).find((s) => !s.current);
    const res = await h.send('delete', `/auth/sessions/${target?.id ?? ''}`, here);
    expect(res.status).toBe(204);
    expect(cleared(res.get('Set-Cookie'))).toEqual([]);
    expect(await h.query('SELECT revoke_reason FROM sessions WHERE id = $1', [target?.id])).toEqual(
      [{ revoke_reason: 'USER_REVOKED' }],
    );
    const refresh = await h.withRefresh('/auth/refresh', there);
    expect(refresh.status).toBe(401);
    expect(refresh.body).toMatchObject({ code: 'SESSION_REVOKED' });
    expect(refresh.body).not.toHaveProperty('reason');
    expect((await h.get('/me', here)).status).toBe(200);
  });

  it('[FR-ACC-06] revoking the current session clears its cookies, like logout', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const jar = await h.loggedIn(user);
    const [current] = await sessionIds(h, jar);
    const res = await h.send('delete', `/auth/sessions/${current?.id ?? ''}`, jar);
    expect(res.status).toBe(204);
    expect(cleared(res.get('Set-Cookie'))).toEqual(['po_access', 'po_csrf', 'po_refresh']);
    expect((await h.get('/me', jar)).body).toMatchObject({ code: 'SESSION_REVOKED' });
  });

  it("[FR-ACC-06] another user's session, an ended one or an unknown id is 404", async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const other = await h.seedUser();
    const jar = await h.loggedIn(user);
    const otherJar = await h.loggedIn(other);
    const [theirs] = await sessionIds(h, otherJar);
    const mine = await h.loggedIn(user);
    const endedEntry = (await sessionIds(h, mine)).find((s) => s.current);
    await h.withRefresh('/auth/logout', mine);
    expect(theirs?.id).toEqual(expect.any(String));
    expect(endedEntry?.id).toEqual(expect.any(String));
    for (const id of [theirs?.id, endedEntry?.id, UNKNOWN_ID]) {
      const res = await h.send('delete', `/auth/sessions/${id ?? ''}`, jar);
      expect(res.status, String(id)).toBe(404);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    }
    expect((await h.get('/me', otherJar)).status).toBe(200);
  });

  it('[NFR-SEC-06] logs session_revoked by the user', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const here = await h.loggedIn(user);
    await h.loggedIn(user);
    const target = (await sessionIds(h, here)).find((s) => !s.current);
    await h.send('delete', `/auth/sessions/${target?.id ?? ''}`, here);
    expect(
      h.logs.some(
        (line) =>
          line['event'] === 'session_revoked' &&
          line['reason'] === 'USER_REVOKED' &&
          line['sessionId'] === target?.id,
      ),
    ).toBe(true);
  });
});
