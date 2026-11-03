import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { LOCKOUT_THRESHOLD } from '../../src/auth/constants.js';
import { hashToken } from '../../src/tokens/one-time.js';
import {
  accountsHarness,
  APP_ORIGIN,
  PASSWORD,
  type AccountsHarness,
} from '../support/accounts.js';

// Reset and set-password (ADR-0017; spec US1 scenario 11, US5 scenarios 2–3).

const NEW_PASSWORD = 'a brand new passphrase';

function reset(h: AccountsHarness, token: string, newPassword = NEW_PASSWORD) {
  return request(h.app)
    .post('/auth/reset-password')
    .set('Origin', APP_ORIGIN)
    .send({ token, newPassword });
}

describe('[FR-ACC-05] reset-password', () => {
  it('[FR-ACC-05] the bootstrap admin sets a password from their link, then logs in', async () => {
    const h = await accountsHarness();
    const admin = await h.seedUser({ roles: '{ADMIN}', password: null });
    expect((await h.login(admin.email, NEW_PASSWORD)).body).toMatchObject({
      code: 'PASSWORD_NOT_SET',
    });
    expect((await reset(h, await h.issue(admin.id))).status).toBe(204);
    expect((await h.login(admin.email, NEW_PASSWORD)).status).toBe(200);
  });

  it('[FR-ACC-05] replaces the password: the old one stops working', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    await reset(h, await h.issue(user.id));
    expect((await h.login(user.email, PASSWORD)).body).toMatchObject({
      code: 'INCORRECT_PASSWORD',
    });
    expect((await h.login(user.email, NEW_PASSWORD)).status).toBe(200);
  });

  it('[FR-ACC-05] revokes every session of the user, which then learns why', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const laptop = await h.loggedIn(user);
    const phone = await h.loggedIn(user);
    await reset(h, await h.issue(user.id));
    for (const jar of [laptop, phone]) {
      expect((await h.withRefresh('/auth/refresh', jar)).body).toMatchObject({
        code: 'SESSION_REVOKED',
        reason: 'PASSWORD_RESET',
      });
    }
  });

  it('[FR-ACC-05] clears a lockout', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) await h.login(user.email, 'wrong password!!');
    await reset(h, await h.issue(user.id));
    expect((await h.login(user.email, NEW_PASSWORD)).status).toBe(200);
  });

  it('[FR-ACC-05] activates an unverified user and audits it as their own email verification', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser({ status: 'UNVERIFIED' });
    await reset(h, await h.issue(user.id));
    expect(await h.query('SELECT status, version FROM users WHERE id = $1', [user.id])).toEqual([
      { status: 'ACTIVE', version: 2 },
    ]);
    expect(
      await h.query(
        `SELECT action, actor_type, actor_user_id::text, acting_role, details
           FROM audit_entries WHERE entity_id = $1`,
        [user.id],
      ),
    ).toEqual([
      {
        action: 'USER_EMAIL_VERIFIED',
        actor_type: 'USER',
        actor_user_id: user.id,
        acting_role: 'SELF',
        details: { via: 'reset' },
      },
    ]);
    expect((await h.login(user.email, NEW_PASSWORD)).status).toBe(200);
  });

  it('[FR-ACC-05] an active user is not re-verified: no audit entry, version unchanged', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    await reset(h, await h.issue(user.id));
    expect(await h.query('SELECT version FROM users WHERE id = $1', [user.id])).toEqual([
      { version: 1 },
    ]);
    expect(await h.query('SELECT 1 FROM audit_entries')).toEqual([]);
  });

  it('[FR-ACC-05] a deactivated user can reset, and still cannot log in', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser({ status: 'DEACTIVATED' });
    expect((await reset(h, await h.issue(user.id))).status).toBe(204);
    expect((await h.login(user.email, NEW_PASSWORD)).body).toMatchObject({
      code: 'ACCOUNT_DEACTIVATED',
    });
  });

  it('[NFR-SEC-06] logs password_reset_completed, and never the token or password', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const token = await h.issue(user.id);
    await reset(h, token);
    expect(h.logs.some((line) => line['event'] === 'password_reset_completed')).toBe(true);
    const logged = JSON.stringify(h.logs);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(NEW_PASSWORD);
  });
});

describe('[FR-ACC-03] reset-password token outcomes', () => {
  it('[FR-ACC-03] a used link is TOKEN_USED', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const token = await h.issue(user.id);
    await reset(h, token);
    const res = await reset(h, token, 'yet another passphrase');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'TOKEN_USED' });
  });

  it('[FR-ACC-03] an older link after a newer one is TOKEN_SUPERSEDED', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const older = await h.issue(user.id);
    await h.issue(user.id);
    expect((await reset(h, older)).body).toMatchObject({ code: 'TOKEN_SUPERSEDED' });
  });

  it('[FR-ACC-03] an expired link is TOKEN_EXPIRED', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const token = await h.issue(user.id);
    await h.query(
      `UPDATE one_time_tokens SET created_at = now() - interval '2 hours',
                                  expires_at = now() - interval '1 second' WHERE token_hash = $1`,
      [hashToken(token)],
    );
    expect((await reset(h, token)).body).toMatchObject({ code: 'TOKEN_EXPIRED' });
  });

  it('[FR-ACC-03] an unknown or verification link is INVALID_TOKEN', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser({ status: 'UNVERIFIED' });
    expect((await reset(h, 'not-a-real-token')).body).toMatchObject({ code: 'INVALID_TOKEN' });
    expect((await reset(h, await h.issue(user.id, 'VERIFY_EMAIL'))).body).toMatchObject({
      code: 'INVALID_TOKEN',
    });
  });
});

describe('[FR-ACC-04] reset-password policy', () => {
  it('[FR-ACC-04] a short or common new password is refused, and the link still works', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const token = await h.issue(user.id);
    expect((await reset(h, token, 'short')).body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'body.newPassword', code: 'PASSWORD_TOO_SHORT' }],
    });
    expect((await reset(h, token, 'Password1234')).body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'body.newPassword', code: 'PASSWORD_TOO_COMMON' }],
    });
    expect((await reset(h, token)).status).toBe(204);
  });
});
