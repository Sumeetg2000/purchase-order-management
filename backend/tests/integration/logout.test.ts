import { describe, expect, it } from 'vitest';
import { ACCESS_TOKEN_LIFETIME_SECONDS } from '../../src/auth/constants.js';
import { SECOND_MS } from '../../src/lib/time.js';
import { accountsHarness, APP_ORIGIN } from '../support/accounts.js';
import request from 'supertest';

// Logout and logout-all (ADR-0017 "Logout and revocation"; spec US1 scenario 9).

function cleared(header: string[] | undefined): string[] {
  return (header ?? [])
    .filter((c) => /Expires=Thu, 01 Jan 1970/.test(c))
    .map((c) => c.split('=')[0] ?? '')
    .sort();
}

describe('[NFR-SEC-03] logout', () => {
  it('[NFR-SEC-03] works with an expired access token, revokes the session and clears its cookies', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const jar = await h.loggedIn(user);
    h.clock.advance((ACCESS_TOKEN_LIFETIME_SECONDS + 60) * SECOND_MS);
    const res = await h.withRefresh('/auth/logout', jar);
    expect(res.status).toBe(204);
    expect(cleared(res.get('Set-Cookie'))).toEqual(['po_access', 'po_csrf', 'po_refresh']);
    expect(await h.query('SELECT revoke_reason FROM sessions')).toEqual([
      { revoke_reason: 'LOGOUT' },
    ]);
    const again = await h.withRefresh('/auth/refresh', jar);
    expect(again.body).toMatchObject({ code: 'SESSION_REVOKED' });
    expect(again.body).not.toHaveProperty('reason');
    expect(h.logs.some((line) => line['event'] === 'logout')).toBe(true);
  });

  it('[NFR-SEC-03] logout ends only its own session', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const laptop = await h.loggedIn(user);
    const phone = await h.loggedIn(user);
    await h.withRefresh('/auth/logout', laptop);
    expect((await h.withRefresh('/auth/refresh', phone)).status).toBe(204);
  });

  it("[NFR-SEC-03] logout-all revokes every session of the user, and no one else's", async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const other = await h.seedUser();
    const laptop = await h.loggedIn(user);
    const phone = await h.loggedIn(user);
    const someoneElse = await h.loggedIn(other);
    const res = await h.withRefresh('/auth/logout-all', laptop);
    expect(res.status).toBe(204);
    expect(cleared(res.get('Set-Cookie'))).toEqual(['po_access', 'po_csrf', 'po_refresh']);
    expect(
      await h.query(`SELECT revoke_reason FROM sessions WHERE user_id = $1`, [user.id]),
    ).toEqual([{ revoke_reason: 'LOGOUT_ALL' }, { revoke_reason: 'LOGOUT_ALL' }]);
    expect((await h.withRefresh('/auth/refresh', phone)).body).toMatchObject({
      code: 'SESSION_REVOKED',
    });
    expect((await h.withRefresh('/auth/refresh', someoneElse)).status).toBe(204);
  });

  it('[NFR-SEC-03] logging out of a session already revoked still answers 204 and clears the cookies', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const jar = await h.loggedIn(user);
    await h.query(`UPDATE sessions SET revoked_at = now(), revoke_reason = 'PASSWORD_RESET'`);
    for (const path of ['/auth/logout', '/auth/logout-all']) {
      const res = await h.withRefresh(path, jar);
      expect(res.status, path).toBe(204);
      expect(cleared(res.get('Set-Cookie')), path).toEqual(['po_access', 'po_csrf', 'po_refresh']);
    }
    // The first revocation's reason stays.
    expect(await h.query('SELECT revoke_reason FROM sessions')).toEqual([
      { revoke_reason: 'PASSWORD_RESET' },
    ]);
  });

  it('[NFR-SEC-03] a deactivated user can still log out: the session ends and the cookies go', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const jar = await h.loggedIn(user);
    await h.query('SET session_replication_role = replica');
    await h.query(`UPDATE users SET status = 'DEACTIVATED', deactivated_at = now() WHERE id = $1`, [
      user.id,
    ]);
    const res = await h.withRefresh('/auth/logout', jar);
    expect(res.status).toBe(204);
    expect(cleared(res.get('Set-Cookie'))).toEqual(['po_access', 'po_csrf', 'po_refresh']);
    expect(await h.query('SELECT revoke_reason FROM sessions')).toEqual([
      { revoke_reason: 'LOGOUT' },
    ]);
  });

  it('[NFR-SEC-03] logging out of an expired session answers 204 and clears the cookies', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const jar = await h.loggedIn(user);
    h.clock.advance(8 * 24 * 60 * 60 * 1_000);
    const res = await h.withRefresh('/auth/logout', jar);
    expect(res.status).toBe(204);
    expect(cleared(res.get('Set-Cookie'))).toEqual(['po_access', 'po_csrf', 'po_refresh']);
  });

  it('[NFR-SEC-04] logout needs the CSRF header like any state change', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const jar = await h.loggedIn(user);
    const res = await h.withRefresh('/auth/logout', { ...jar, po_csrf: 'wrong' });
    expect(res.body).toMatchObject({ code: 'CSRF_REJECTED' });
  });
});

describe('[FR-USR-01] the current user', () => {
  it('[FR-USR-01] GET /me returns id, name, email, roles and signup date', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser({ name: 'Asha Rao', roles: '{BUYER,APPROVER}' });
    const res = await h.get('/me', await h.loggedIn(user));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: user.id,
      name: 'Asha Rao',
      email: user.email,
      roles: ['BUYER', 'APPROVER'],
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as unknown,
    });
  });

  it('[FR-ACC-08] a user with no role can read their profile', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser({ roles: '{}' });
    const res = await h.get('/me', await h.loggedIn(user));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ roles: [] });
  });
});

describe('[NFR-SEC-03] revocation on the next request', () => {
  it('[NFR-SEC-03] after logout, the old access token gets SESSION_REVOKED on its next request', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const jar = await h.loggedIn(user);
    await h.withRefresh('/auth/logout', jar);
    const res = await h.get('/me', jar);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'SESSION_REVOKED' });
    expect(res.body).not.toHaveProperty('reason');
  });

  it('[NFR-SEC-03] after a password change, the old access token learns why on its next request', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const jar = await h.loggedIn(user);
    // As change-password (US4) revokes the other sessions.
    await h.query(`UPDATE sessions SET revoked_at = now(), revoke_reason = 'PASSWORD_CHANGED'`);
    expect((await h.get('/me', jar)).body).toMatchObject({
      code: 'SESSION_REVOKED',
      reason: 'PASSWORD_CHANGED',
    });
  });

  it('[NFR-SEC-03] after a password reset, the old access token gets SESSION_REVOKED with the reason', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const jar = await h.loggedIn(user);
    await request(h.app)
      .post('/auth/reset-password')
      .set('Origin', APP_ORIGIN)
      .send({ token: await h.issue(user.id), newPassword: 'a brand new passphrase' });
    expect((await h.get('/me', jar)).body).toMatchObject({
      code: 'SESSION_REVOKED',
      reason: 'PASSWORD_RESET',
    });
  });

  it('[NFR-SEC-09] a session past its end gets SESSION_EXPIRED even with a fresh access token', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const jar = await h.loggedIn(user);
    const end = new Date(h.clock.now().getTime() + 60_000);
    await h.query(`UPDATE sessions SET expires_at = $1, absolute_expires_at = $1`, [end]);
    h.clock.advance(120_000);
    const res = await h.get('/me', jar);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'SESSION_EXPIRED' });
  });

  it('[NFR-AUTH-01] a request with no access cookie is UNAUTHENTICATED, even with a valid session', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const jar = await h.loggedIn(user);
    const res = await request(h.app)
      .get('/me')
      .set('Cookie', `po_refresh=${jar['po_refresh'] ?? ''}; po_csrf=${jar['po_csrf'] ?? ''}`);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});
