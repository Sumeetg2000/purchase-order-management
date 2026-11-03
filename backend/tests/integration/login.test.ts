import { describe, expect, it } from 'vitest';
import { LOCKOUT_DURATION_SECONDS, LOCKOUT_THRESHOLD } from '../../src/auth/constants.js';
import { createPrismaClient } from '../../src/db/client.js';
import { withTransaction } from '../../src/db/transaction.js';
import { recordSuccessfulLogin } from '../../src/users/repository.js';
import { accountsHarness, cookiesSet, PASSWORD } from '../support/accounts.js';
import { TOKEN_SHAPED } from '../support/log-capture.js';

// Login (ADR-0017 "Login, lockout and rate limits"; spec US1 scenarios 1–4, 11).

const WRONG = 'not the right password';

describe('[NFR-SEC-05] login checks, in order', () => {
  it('[NFR-SEC-05] an unknown email is 404 ACCOUNT_NOT_FOUND', async () => {
    const h = await accountsHarness();
    const res = await h.login('nobody@example.local', PASSWORD);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
  });

  it('[NFR-SEC-05] an account with no password set is 401 PASSWORD_NOT_SET, whatever is typed', async () => {
    const h = await accountsHarness();
    const admin = await h.seedUser({ roles: '{ADMIN}', password: null });
    const res = await h.login(admin.email, PASSWORD);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'PASSWORD_NOT_SET' });
  });

  it('[NFR-SEC-05] a wrong password is 401 INCORRECT_PASSWORD', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const res = await h.login(user.email, WRONG);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'INCORRECT_PASSWORD' });
  });

  it('[NFR-SEC-05] the password is checked before the status', async () => {
    const h = await accountsHarness();
    const unverified = await h.seedUser({ status: 'UNVERIFIED' });
    const deactivated = await h.seedUser({ status: 'DEACTIVATED' });
    expect((await h.login(unverified.email, WRONG)).body).toMatchObject({
      code: 'INCORRECT_PASSWORD',
    });
    expect((await h.login(unverified.email, PASSWORD)).body).toMatchObject({
      code: 'ACCOUNT_NOT_VERIFIED',
    });
    expect((await h.login(deactivated.email, WRONG)).body).toMatchObject({
      code: 'INCORRECT_PASSWORD',
    });
    const res = await h.login(deactivated.email, PASSWORD);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'ACCOUNT_DEACTIVATED' });
  });

  it('[NFR-SEC-05] the email matches whatever its case', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    expect((await h.login(user.email.toUpperCase(), PASSWORD)).status).toBe(200);
  });
});

describe('[NFR-SEC-01] a successful login', () => {
  it('[NFR-SEC-01] answers with the user and sets three cookies, with no token in the body', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser({ name: 'Asha Rao' });
    const res = await h.login(user.email, PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: user.id,
      name: 'Asha Rao',
      email: user.email,
      roles: ['BUYER'],
      status: 'ACTIVE',
      createdAt: expect.any(String) as unknown,
    });
    expect(JSON.stringify(res.body)).not.toMatch(TOKEN_SHAPED);
    expect(Object.keys(cookiesSet(res)).sort()).toEqual(['po_access', 'po_csrf', 'po_refresh']);
  });

  it('[NFR-SEC-01] records the login time and opens one session with one hashed refresh token', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const jar = cookiesSet(await h.login(user.email, PASSWORD, '10.1.2.3'));
    const [row] = await h.query<{ last_login_at: Date }>(
      'SELECT last_login_at FROM users WHERE id = $1',
      [user.id],
    );
    expect(row?.last_login_at.toISOString()).toBe(h.clock.now().toISOString());
    const sessions = await h.query<{ ip: string; absolute: string; expires: string }>(
      `SELECT host(ip) AS ip, (absolute_expires_at - created_at)::text AS absolute,
              (expires_at - created_at)::text AS expires FROM sessions WHERE user_id = $1`,
      [user.id],
    );
    expect(sessions).toEqual([{ ip: '10.1.2.3', absolute: '30 days', expires: '7 days' }]);
    const tokens = await h.query<{ hash: Buffer }>('SELECT token_hash AS hash FROM refresh_tokens');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.hash.toString('base64url')).not.toBe(jar['po_refresh']);
  });

  it('[NFR-SEC-06] logs login_succeeded and login_failed with the reason, and never the password', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    await h.login(user.email, WRONG);
    await h.login(user.email, PASSWORD);
    const events = h.logs.filter((line) => line['security'] === true);
    expect(events.map((e) => [e['event'], e['reason']])).toEqual([
      ['login_failed', 'wrong_password'],
      ['login_succeeded', undefined],
    ]);
    expect(JSON.stringify(h.logs)).not.toContain(PASSWORD);
    expect(JSON.stringify(h.logs)).not.toContain(WRONG);
  });
});

describe('[NFR-SEC-07] per-account lockout', () => {
  it('[NFR-SEC-07] four wrong passwords are INCORRECT_PASSWORD; the fifth locks with 423 and Retry-After', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    for (let i = 1; i < LOCKOUT_THRESHOLD; i += 1) {
      expect((await h.login(user.email, WRONG)).body).toMatchObject({ code: 'INCORRECT_PASSWORD' });
    }
    const locked = await h.login(user.email, WRONG);
    expect(locked.status).toBe(423);
    expect(locked.body).toMatchObject({ code: 'ACCOUNT_LOCKED' });
    expect(locked.get('Retry-After')).toBe(String(LOCKOUT_DURATION_SECONDS));
    expect(h.logs.some((line) => line['event'] === 'account_locked')).toBe(true);
  });

  it('[NFR-SEC-07] while locked, even the right password gets 423; after 15 minutes it works', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) await h.login(user.email, WRONG);
    h.clock.advance(60_000);
    const res = await h.login(user.email, PASSWORD);
    expect(res.status).toBe(423);
    expect(res.get('Retry-After')).toBe(String(LOCKOUT_DURATION_SECONDS - 60));
    h.clock.advance((LOCKOUT_DURATION_SECONDS - 60) * 1_000);
    expect((await h.login(user.email, PASSWORD)).status).toBe(200);
  });

  it('[NFR-SEC-07] a successful login resets the count', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    for (let i = 1; i < LOCKOUT_THRESHOLD; i += 1) await h.login(user.email, WRONG);
    expect((await h.login(user.email, PASSWORD)).status).toBe(200);
    for (let i = 1; i < LOCKOUT_THRESHOLD; i += 1) {
      expect((await h.login(user.email, WRONG)).body).toMatchObject({ code: 'INCORRECT_PASSWORD' });
    }
  });

  it('[NFR-SEC-07] the lockout holds across two API instances', async () => {
    const h = await accountsHarness();
    const other = h.secondInstance();
    const user = await h.seedUser();
    for (let i = 1; i < LOCKOUT_THRESHOLD; i += 1) {
      await h.login(user.email, WRONG, '10.0.0.1', i % 2 === 0 ? h.app : other);
    }
    expect((await h.login(user.email, WRONG, '10.0.0.1', other)).status).toBe(423);
    expect((await h.login(user.email, PASSWORD, '10.0.0.1', h.app)).status).toBe(423);
  });

  it('[NFR-SEC-07] concurrent wrong passwords can never skip the lock', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const results = await Promise.all(
      Array.from({ length: LOCKOUT_THRESHOLD }, () => h.login(user.email, WRONG)),
    );
    expect(results.filter((r) => r.status === 423)).toHaveLength(1);
    expect((await h.login(user.email, PASSWORD)).status).toBe(423);
  });
});

describe('[NFR-SEC-07] lockout under a race', () => {
  it('[NFR-SEC-07] a right password whose check started before a lock does not clear it', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    // As if concurrent wrong guesses locked the account while this attempt was checking
    // the password: the success write must see the lock and refuse.
    const lockedUntil = new Date(h.clock.now().getTime() + 600_000);
    const prisma = createPrismaClient({
      url: h.db.url('po_app'),
      poolSize: 1,
      connectionTimeoutMs: 2_000,
    });
    try {
      await h.query(`SET session_replication_role = replica`);
      await h.query(`UPDATE users SET locked_until = $2 WHERE id = $1`, [user.id, lockedUntil]);
      const outcome = await withTransaction(
        {
          prisma,
          actor: { type: 'SYSTEM' },
          requestId: 'req-race',
          timeoutMs: 5_000,
          maxWaitMs: 2_000,
        },
        (tx) => recordSuccessfulLogin(tx, { id: user.id, now: h.clock.now() }),
      );
      expect(outcome).toEqual({ ok: false, lockedUntil });
    } finally {
      await prisma.$disconnect();
    }
    const [row] = await h.query<{ locked_until: Date | null; last_login_at: Date | null }>(
      'SELECT locked_until, last_login_at FROM users WHERE id = $1',
      [user.id],
    );
    expect(row?.locked_until?.toISOString()).toBe(lockedUntil.toISOString());
    expect(row?.last_login_at).toBeNull();
  });
});

describe('[NFR-SEC-05] login rate limits', () => {
  it('[NFR-SEC-05] the 31st attempt from one address within a minute is 429, whatever the account', async () => {
    const h = await accountsHarness();
    for (let i = 0; i < 30; i += 1) {
      expect((await h.login(`n${String(i)}@example.local`, PASSWORD, '10.9.9.9')).status).toBe(404);
    }
    const res = await h.login('n31@example.local', PASSWORD, '10.9.9.9');
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: 'RATE_LIMITED' });
    expect(Number(res.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('[NFR-SEC-05] the 11th attempt on one account within a minute is 429, whatever the address', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    // Right password, so the lockout never interferes.
    for (let i = 0; i < 10; i += 1) {
      expect((await h.login(user.email, PASSWORD, `10.0.1.${String(i)}`)).status).toBe(200);
    }
    expect((await h.login(user.email, PASSWORD, '10.0.2.1')).status).toBe(429);
  });
});
