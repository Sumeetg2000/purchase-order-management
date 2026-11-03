import { describe, expect, it } from 'vitest';
import { ACCESS_TOKEN_LIFETIME_SECONDS } from '../../src/auth/constants.js';
import { SECOND_MS } from '../../src/lib/time.js';
import { accountsHarness } from '../support/accounts.js';

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

  it('[NFR-SEC-04] logout needs the CSRF header like any state change', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const jar = await h.loggedIn(user);
    const res = await h.withRefresh('/auth/logout', { ...jar, po_csrf: 'wrong' });
    expect(res.body).toMatchObject({ code: 'CSRF_REJECTED' });
  });
});

describe('[FR-USR-01] the current user', () => {
  it('[FR-USR-01] GET /me returns id, name, email, roles, status and signup date', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser({ name: 'Asha Rao', roles: '{BUYER,APPROVER}' });
    const res = await h.get('/me', await h.loggedIn(user));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: user.id,
      name: 'Asha Rao',
      email: user.email,
      roles: ['BUYER', 'APPROVER'],
      status: 'ACTIVE',
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
