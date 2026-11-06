import { describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_LIFETIME_SECONDS,
  REFRESH_SIBLING_GRACE_SECONDS,
} from '../../src/auth/constants.js';
import { DAY_SECONDS, SECOND_MS } from '../../src/lib/time.js';
import { accountsHarness, cookiesSet, type CookieJar } from '../support/accounts.js';

// Refresh rotation, the sibling window, reuse detection and session lifetimes (ADR-0017,
// research R5 and R6; spec US1 scenarios 5, 7, 8, 10).

async function loggedInUser() {
  const h = await accountsHarness();
  const user = await h.seedUser();
  const jar = await h.loggedIn(user);
  return { h, user, jar };
}

/** Refreshes and merges the new cookies over the old, as a browser would. */
async function refresh(h: Awaited<ReturnType<typeof accountsHarness>>, jar: CookieJar) {
  const res = await h.withRefresh('/auth/refresh', jar);
  return { res, jar: { ...jar, ...cookiesSet(res) } };
}

describe('[NFR-SEC-02] rotation', () => {
  it('[NFR-SEC-02] a refresh answers 204 with a new access and refresh token in the same session', async () => {
    const { h, jar } = await loggedInUser();
    const { res, jar: next } = await refresh(h, jar);
    expect(res.status).toBe(204);
    expect(next['po_refresh']).not.toBe(jar['po_refresh']);
    expect(next['po_access']).toBeTruthy();
    // The CSRF token is bound to the session, which hasn't changed.
    expect(next['po_csrf']).toBe(jar['po_csrf']);
    expect(await h.query('SELECT 1 FROM sessions')).toHaveLength(1);
    expect((await h.get('/me', next)).status).toBe(200);
  });

  it('[NFR-SEC-02] a rotated token presented within 10 seconds gets a sibling; the session stays valid', async () => {
    const { h, jar } = await loggedInUser();
    const first = await refresh(h, jar);
    h.clock.advance(REFRESH_SIBLING_GRACE_SECONDS * SECOND_MS);
    const sibling = await refresh(h, jar);
    expect(sibling.res.status).toBe(204);
    expect(sibling.jar['po_refresh']).not.toBe(first.jar['po_refresh']);
    expect((await refresh(h, first.jar)).res.status).toBe(204);
    expect((await refresh(h, sibling.jar)).res.status).toBe(204);
  });

  it('[NFR-SEC-02] two tabs refreshing one token at once both succeed', async () => {
    const { h, jar } = await loggedInUser();
    const results = await Promise.all([
      h.withRefresh('/auth/refresh', jar),
      h.withRefresh('/auth/refresh', jar),
    ]);
    expect(results.map((r) => r.status)).toEqual([204, 204]);
  });

  it('[NFR-SEC-02] reuse after the window revokes the whole session: 401 SESSION_REVOKED with no reason', async () => {
    const { h, jar } = await loggedInUser();
    const fresh = await refresh(h, jar);
    h.clock.advance((REFRESH_SIBLING_GRACE_SECONDS + 1) * SECOND_MS);
    const reuse = await h.withRefresh('/auth/refresh', jar);
    expect(reuse.status).toBe(401);
    expect(reuse.body).toMatchObject({ code: 'SESSION_REVOKED' });
    expect(reuse.body).not.toHaveProperty('reason');
    // The legitimate holder's newer token dies with the session.
    expect((await h.withRefresh('/auth/refresh', fresh.jar)).body).toMatchObject({
      code: 'SESSION_REVOKED',
    });
    expect(await h.query('SELECT revoke_reason FROM sessions')).toEqual([
      { revoke_reason: 'REUSE_DETECTED' },
    ]);
    expect(h.logs.some((line) => line['event'] === 'refresh_reuse_detected')).toBe(true);
  });
});

describe('[NFR-SEC-02] revoked sessions', () => {
  it.each(['PASSWORD_CHANGED', 'PASSWORD_RESET', 'ROLES_CHANGED'])(
    '[NFR-SEC-02] a session revoked for %s says so in the reason',
    async (reason) => {
      const { h, jar } = await loggedInUser();
      await h.query(`UPDATE sessions SET revoked_at = now(), revoke_reason = $1`, [reason]);
      const res = await h.withRefresh('/auth/refresh', jar);
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'SESSION_REVOKED', reason });
    },
  );

  it.each(['LOGOUT', 'LOGOUT_ALL', 'USER_REVOKED', 'REUSE_DETECTED'])(
    '[NFR-SEC-02] a session revoked for %s gives no reason',
    async (reason) => {
      const { h, jar } = await loggedInUser();
      await h.query(`UPDATE sessions SET revoked_at = now(), revoke_reason = $1`, [reason]);
      const res = await h.withRefresh('/auth/refresh', jar);
      expect(res.body).toMatchObject({ code: 'SESSION_REVOKED' });
      expect(res.body).not.toHaveProperty('reason');
    },
  );

  it('[NFR-SEC-03] a deactivated user gets ACCOUNT_DEACTIVATED, not SESSION_REVOKED', async () => {
    const { h, user, jar } = await loggedInUser();
    await h.query(`SET session_replication_role = replica`);
    await h.query(`UPDATE users SET status = 'DEACTIVATED', deactivated_at = now() WHERE id = $1`, [
      user.id,
    ]);
    await h.query(`UPDATE sessions SET revoked_at = now(), revoke_reason = 'DEACTIVATED'`);
    const res = await h.withRefresh('/auth/refresh', jar);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'ACCOUNT_DEACTIVATED' });
  });
});

describe('[NFR-SEC-09] session lifetimes', () => {
  it('[NFR-SEC-09] a session unused for 7 days ends: 401 SESSION_EXPIRED', async () => {
    const { h, jar } = await loggedInUser();
    h.clock.advance(7 * DAY_SECONDS * SECOND_MS);
    const res = await h.withRefresh('/auth/refresh', jar);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'SESSION_EXPIRED' });
  });

  it('[NFR-SEC-09] a session refreshed every day still ends 30 days after login', async () => {
    const start = await loggedInUser();
    const { h } = start;
    let { jar } = start;
    for (let day = 1; day < 30; day += 1) {
      h.clock.advance(DAY_SECONDS * SECOND_MS);
      const next = await refresh(h, jar);
      expect(next.res.status, `day ${String(day)}`).toBe(204);
      jar = next.jar;
    }
    const [row] = await h.query<{ over: boolean }>(
      `SELECT bool_or(t.expires_at > s.absolute_expires_at) AS over
         FROM refresh_tokens t JOIN sessions s ON s.id = t.session_id`,
    );
    expect(row?.over).toBe(false);
    h.clock.advance(DAY_SECONDS * SECOND_MS);
    expect((await h.withRefresh('/auth/refresh', jar)).body).toMatchObject({
      code: 'SESSION_EXPIRED',
    });
  });

  it("[NFR-SEC-09] near the absolute limit, the refresh cookie lives only until the session's end", async () => {
    const start = await loggedInUser();
    const { h } = start;
    let { jar } = start;
    // Refreshed every 6 days, so the 7-day idle limit never ends it first.
    for (const days of [6, 6, 6, 6, 5]) {
      h.clock.advance(days * DAY_SECONDS * SECOND_MS);
      ({ jar } = await refresh(h, jar));
    }
    const { res } = await refresh(h, jar);
    const refreshCookie = (res.get('Set-Cookie') ?? []).find((c) => c.startsWith('po_refresh='));
    expect(refreshCookie).toContain(`Max-Age=${String(DAY_SECONDS)};`);
  });

  it('[SC-004] a user working 8 hours, refreshing as each access token expires, is never logged out', async () => {
    const start = await loggedInUser();
    const { h } = start;
    let { jar } = start;
    for (let i = 0; i < (8 * 60 * 60) / ACCESS_TOKEN_LIFETIME_SECONDS; i += 1) {
      h.clock.advance(ACCESS_TOKEN_LIFETIME_SECONDS * SECOND_MS);
      expect((await h.get('/me', jar)).body).toMatchObject({ code: 'ACCESS_TOKEN_EXPIRED' });
      const next = await refresh(h, jar);
      expect(next.res.status).toBe(204);
      jar = next.jar;
      expect((await h.get('/me', jar)).status).toBe(200);
    }
  });

  it('[NFR-SEC-04] the CSRF cookie lasts as long as the refresh cookie, so a refresh after a browser restart passes', async () => {
    const { h, jar } = await loggedInUser();
    const res = await h.withRefresh('/auth/refresh', jar);
    const header = res.get('Set-Cookie') ?? [];
    const maxAge = (name: string) =>
      /Max-Age=(\d+)/.exec(header.find((c) => c.startsWith(`${name}=`)) ?? '')?.[1];
    expect(maxAge('po_csrf')).toBe(maxAge('po_refresh'));
    // A restart drops only cookies without Max-Age; the access cookie expires anyway.
    const afterRestart = {
      po_refresh: cookiesSet(res)['po_refresh'] ?? '',
      po_csrf: jar['po_csrf'] ?? '',
    };
    expect((await h.withRefresh('/auth/refresh', afterRestart)).status).toBe(204);
  });
});
