import { describe, expect, it } from 'vitest';
import { LOCKOUT_THRESHOLD } from '../../src/auth/constants.js';
import { hashToken } from '../../src/tokens/one-time.js';
import { accountsHarness, type AccountsHarness } from '../support/accounts.js';

// Signup, verification and resend (ADR-0017 "Signup and verification"; spec US2
// scenarios 1–6).

const NEW_PASSWORD = 'a fresh signup passphrase';

function signup(h: AccountsHarness, email: string, ip = '10.0.0.1', extra: object = {}) {
  return h.post(
    '/auth/signup',
    { name: 'Ravi Kumar', email, password: NEW_PASSWORD, ...extra },
    ip,
  );
}

/** The token in the newest verification email to an address. */
async function linkTokenFor(h: AccountsHarness, email: string): Promise<string> {
  const mail = (await h.sentMail()).filter((m) => m.to === email && m.template === 'verify_email');
  const token = /\/verify-email#token=([A-Za-z0-9_-]+)/.exec(mail.at(-1)?.text ?? '')?.[1];
  if (!token) throw new Error(`no verification link sent to ${email}`);
  return token;
}

const verify = (h: AccountsHarness, token: string, password = NEW_PASSWORD) =>
  h.post('/auth/verify-email', { token, password });

const WRONG_PASSWORD = 'not the signup passphrase';

const wrongPasswordDetails = [{ path: 'body.password', code: 'INCORRECT_PASSWORD' }];

describe('[FR-ACC-01] signup', () => {
  it('[FR-ACC-01] creates an unverified account with no role and sends a verification link', async () => {
    const h = await accountsHarness();
    const res = await signup(h, 'ravi@example.local');
    expect(res.status).toBe(202);
    expect(res.text).toBe('');
    expect(
      await h.query('SELECT name, email, roles, status FROM users WHERE email = $1', [
        'ravi@example.local',
      ]),
    ).toEqual([
      { name: 'Ravi Kumar', email: 'ravi@example.local', roles: [], status: 'UNVERIFIED' },
    ]);
    const [mail] = await h.sentMail();
    expect(mail).toMatchObject({ template: 'verify_email', to: 'ravi@example.local' });
    expect(mail?.text).toMatch(/^http:\/\/localhost:8080\/verify-email#token=[A-Za-z0-9_-]{43}$/m);
  });

  it("[FR-ACC-02] the verification email tells someone who didn't sign up how to claim the address", async () => {
    const h = await accountsHarness();
    await signup(h, 'ravi@example.local');
    const [mail] = await h.sentMail();
    const advice =
      "If you didn't sign up, ignore this email. To use this address yourself, reset your password from the login page.";
    expect(mail?.text).toContain(advice);
    expect(mail?.html).toContain(advice);
  });

  it('[FR-ACC-01] audits the signup as the user themself, with the email domain and no role', async () => {
    const h = await accountsHarness();
    await signup(h, 'ravi@example.local');
    expect(
      await h.query(
        `SELECT action, actor_type, acting_role, actor_email, details FROM audit_entries`,
      ),
    ).toEqual([
      {
        action: 'USER_SIGNED_UP',
        actor_type: 'USER',
        acting_role: 'SELF',
        actor_email: 'ravi@example.local',
        details: { emailDomain: 'example.local', roles: [] },
      },
    ]);
  });

  it('[FR-ACC-01] matches the domain whatever its case, and stores the email lower-cased', async () => {
    const h = await accountsHarness();
    expect((await signup(h, 'Ravi@EXAMPLE.Local')).status).toBe(202);
    expect(await h.query('SELECT email FROM users')).toEqual([{ email: 'ravi@example.local' }]);
  });

  it('[FR-ACC-01] refuses a domain that is not allowed, creating nothing', async () => {
    const h = await accountsHarness();
    const res = await signup(h, 'ravi@elsewhere.example');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'SIGNUP_DOMAIN_NOT_ALLOWED' });
    expect(await h.query('SELECT 1 FROM users')).toEqual([]);
  });

  it.each(['ACTIVE', 'UNVERIFIED', 'DEACTIVATED'])(
    '[FR-ACC-01] an email that has an account (%s) is 409 EMAIL_IN_USE, and nothing is created or sent',
    async (status) => {
      const h = await accountsHarness();
      const existing = await h.seedUser({ status });
      const res = await signup(h, existing.email);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'EMAIL_IN_USE' });
      expect(await h.query('SELECT 1 FROM users')).toHaveLength(1);
      expect(await h.sentMail()).toEqual([]);
    },
  );

  it.each([
    ['roles', { roles: ['ADMIN'] }],
    ['status', { status: 'ACTIVE' }],
  ])('[FR-ACC-01] a body with %s is refused, creating nothing', async (field, extra) => {
    const h = await accountsHarness();
    const res = await signup(h, 'ravi@example.local', '10.0.0.1', extra);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: `body.${field}`, code: 'UNKNOWN_FIELD' }],
    });
    expect(await h.query('SELECT 1 FROM users')).toEqual([]);
  });

  it('[FR-ACC-04] a common password is refused with PASSWORD_TOO_COMMON', async () => {
    const h = await accountsHarness();
    const res = await h.post('/auth/signup', {
      name: 'Ravi',
      email: 'ravi@example.local',
      password: 'Password1234',
    });
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'body.password', code: 'PASSWORD_TOO_COMMON' }],
    });
  });

  it('[NFR-SEC-08] the 6th signup from one address within an hour is 429', async () => {
    const h = await accountsHarness();
    for (let i = 0; i < 5; i += 1) {
      expect((await signup(h, `r${String(i)}@example.local`, '10.7.7.7')).status).toBe(202);
    }
    const res = await signup(h, 'r6@example.local', '10.7.7.7');
    expect(res.status).toBe(429);
    expect(Number(res.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('[NFR-SEC-08] the 4th signup for one email within an hour is 429, whatever the address', async () => {
    const h = await accountsHarness();
    for (let i = 0; i < 3; i += 1) await signup(h, 'ravi@example.local', `10.0.3.${String(i)}`);
    expect((await signup(h, 'ravi@example.local', '10.0.4.1')).status).toBe(429);
  });

  it('[NFR-SEC-06] logs the signup as a security event', async () => {
    const h = await accountsHarness();
    await signup(h, 'ravi@example.local');
    expect(h.logs.some((line) => line['event'] === 'signup')).toBe(true);
    expect(JSON.stringify(h.logs)).not.toContain(NEW_PASSWORD);
  });
});

describe('[FR-ACC-02] email verification', () => {
  it('[FR-ACC-02] the emailed link activates the account without logging in', async () => {
    const h = await accountsHarness();
    await signup(h, 'ravi@example.local');
    const res = await verify(h, await linkTokenFor(h, 'ravi@example.local'));
    expect(res.status).toBe(204);
    expect(res.get('Set-Cookie')).toBeUndefined();
    expect(await h.query('SELECT status, version FROM users')).toEqual([
      { status: 'ACTIVE', version: 2 },
    ]);
    expect((await h.login('ravi@example.local', NEW_PASSWORD)).status).toBe(200);
  });

  it('[FR-ACC-02] audits the verification as the user themself, by link', async () => {
    const h = await accountsHarness();
    await signup(h, 'ravi@example.local');
    await verify(h, await linkTokenFor(h, 'ravi@example.local'));
    expect(
      await h.query(
        `SELECT details, acting_role FROM audit_entries WHERE action = 'USER_EMAIL_VERIFIED'`,
      ),
    ).toEqual([{ details: { via: 'link' }, acting_role: 'SELF' }]);
    expect(h.logs.some((line) => line['event'] === 'email_verified')).toBe(true);
  });

  it('[FR-ACC-02] a link for an account deactivated since is 401 ACCOUNT_DEACTIVATED, and stays unused', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser({ status: 'UNVERIFIED' });
    const token = await h.issue(user.id, 'VERIFY_EMAIL');
    await h.query('SET session_replication_role = replica');
    await h.query(`UPDATE users SET status = 'DEACTIVATED', deactivated_at = now() WHERE id = $1`, [
      user.id,
    ]);
    const res = await verify(h, token);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'ACCOUNT_DEACTIVATED' });
    expect(await h.query('SELECT used_at FROM one_time_tokens')).toEqual([{ used_at: null }]);
    expect(h.logs.some((line) => line['event'] === 'email_verified')).toBe(false);
  });

  it('[FR-ACC-03] a used link is TOKEN_USED', async () => {
    const h = await accountsHarness();
    await signup(h, 'ravi@example.local');
    const token = await linkTokenFor(h, 'ravi@example.local');
    await verify(h, token);
    expect((await verify(h, token)).body).toMatchObject({ code: 'TOKEN_USED' });
  });

  it('[FR-ACC-03] an expired link is TOKEN_EXPIRED', async () => {
    const h = await accountsHarness();
    await signup(h, 'ravi@example.local');
    const token = await linkTokenFor(h, 'ravi@example.local');
    await h.query(
      `UPDATE one_time_tokens SET created_at = now() - interval '2 days',
                                  expires_at = now() - interval '1 second' WHERE token_hash = $1`,
      [hashToken(token)],
    );
    expect((await verify(h, token)).body).toMatchObject({ code: 'TOKEN_EXPIRED' });
  });

  it('[FR-ACC-03] an unknown token or a reset link is INVALID_TOKEN', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser({ status: 'UNVERIFIED' });
    expect((await verify(h, 'not-a-real-token')).body).toMatchObject({ code: 'INVALID_TOKEN' });
    expect((await verify(h, await h.issue(user.id, 'RESET'))).body).toMatchObject({
      code: 'INVALID_TOKEN',
    });
  });
});

describe('[FR-ACC-02] verification asks for the password chosen at signup', () => {
  it('[FR-ACC-02] a wrong password activates nothing: 400 INCORRECT_PASSWORD on body.password, and the link stays unused', async () => {
    const h = await accountsHarness();
    await signup(h, 'ravi@example.local');
    const res = await verify(h, await linkTokenFor(h, 'ravi@example.local'), WRONG_PASSWORD);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED', details: wrongPasswordDetails });
    expect(await h.query('SELECT status, failed_login_count FROM users')).toEqual([
      { status: 'UNVERIFIED', failed_login_count: 1 },
    ]);
    expect(await h.query('SELECT used_at FROM one_time_tokens')).toEqual([{ used_at: null }]);
    expect(
      await h.query(
        `SELECT count(*)::int AS n FROM audit_entries WHERE action = 'USER_EMAIL_VERIFIED'`,
      ),
    ).toEqual([{ n: 0 }]);
    expect(h.logs.filter((line) => line['event'] === 'email_verification_failed')).toEqual([
      expect.objectContaining({ reason: 'wrong_password' }),
    ]);
    expect(h.logs.some((line) => line['event'] === 'email_verified')).toBe(false);
  });

  it('[FR-ACC-02] after a wrong password, the right one activates the account with the same link', async () => {
    const h = await accountsHarness();
    await signup(h, 'ravi@example.local');
    const token = await linkTokenFor(h, 'ravi@example.local');
    expect((await verify(h, token, WRONG_PASSWORD)).status).toBe(400);
    expect((await verify(h, token)).status).toBe(204);
    expect(await h.query('SELECT status FROM users')).toEqual([{ status: 'ACTIVE' }]);
    expect((await h.login('ravi@example.local', NEW_PASSWORD)).status).toBe(200);
  });

  it('[NFR-SEC-07] wrong passwords count toward the lockout like login; once locked, the right one is 423 too', async () => {
    const h = await accountsHarness();
    await signup(h, 'ravi@example.local');
    const token = await linkTokenFor(h, 'ravi@example.local');
    for (let attempt = 1; attempt < LOCKOUT_THRESHOLD; attempt++) {
      expect((await verify(h, token, WRONG_PASSWORD)).status).toBe(400);
    }
    const locking = await verify(h, token, WRONG_PASSWORD);
    expect(locking.status).toBe(423);
    expect(locking.body).toMatchObject({ code: 'ACCOUNT_LOCKED' });
    expect(locking.get('Retry-After')).toMatch(/^\d+$/);
    expect(h.logs.some((line) => line['event'] === 'account_locked')).toBe(true);

    const right = await verify(h, token);
    expect(right.status).toBe(423);
    expect(right.body).toMatchObject({ code: 'ACCOUNT_LOCKED' });
    expect(await h.query('SELECT status FROM users')).toEqual([{ status: 'UNVERIFIED' }]);
    expect(await h.query('SELECT used_at FROM one_time_tokens')).toEqual([{ used_at: null }]);
  });

  it('[FR-ACC-02] checks the link first, then deactivation, then the lockout, then the password', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser({ status: 'UNVERIFIED' });
    const token = await h.issue(user.id, 'VERIFY_EMAIL');
    await h.query('SET session_replication_role = replica');
    await h.query(
      `UPDATE users SET status = 'DEACTIVATED', deactivated_at = now(),
                        locked_until = now() + interval '10 minutes' WHERE id = $1`,
      [user.id],
    );
    expect((await verify(h, 'not-a-real-token', WRONG_PASSWORD)).body).toMatchObject({
      code: 'INVALID_TOKEN',
    });
    expect((await verify(h, token, WRONG_PASSWORD)).body).toMatchObject({
      code: 'ACCOUNT_DEACTIVATED',
    });
    await h.query(`UPDATE users SET status = 'UNVERIFIED', deactivated_at = NULL WHERE id = $1`, [
      user.id,
    ]);
    expect((await verify(h, token, WRONG_PASSWORD)).body).toMatchObject({
      code: 'ACCOUNT_LOCKED',
    });
    await h.query('UPDATE users SET locked_until = NULL WHERE id = $1', [user.id]);
    expect((await verify(h, token, WRONG_PASSWORD)).body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: wrongPasswordDetails,
    });
    expect((await verify(h, token, user.password)).status).toBe(204);
  });

  it('[FR-ACC-02] a password is required: a body without one is 400 and activates nothing', async () => {
    const h = await accountsHarness();
    await signup(h, 'ravi@example.local');
    const token = await linkTokenFor(h, 'ravi@example.local');
    expect((await h.post('/auth/verify-email', { token })).status).toBe(400);
    expect(await h.query('SELECT status FROM users')).toEqual([{ status: 'UNVERIFIED' }]);
  });
});

describe('[FR-ACC-02] resend verification', () => {
  it('[FR-ACC-02] sends a new link, and the earlier one becomes TOKEN_SUPERSEDED', async () => {
    const h = await accountsHarness();
    await signup(h, 'ravi@example.local');
    const first = await linkTokenFor(h, 'ravi@example.local');
    const res = await h.post('/auth/resend-verification', { email: 'Ravi@example.local' });
    expect(res.status).toBe(202);
    const second = await linkTokenFor(h, 'ravi@example.local');
    expect(second).not.toBe(first);
    expect((await verify(h, first)).body).toMatchObject({ code: 'TOKEN_SUPERSEDED' });
    expect((await verify(h, second)).status).toBe(204);
  });

  it.each([
    ['an unknown email', undefined, 404, 'ACCOUNT_NOT_FOUND'],
    ['an active account', 'ACTIVE', 409, 'ACCOUNT_ALREADY_VERIFIED'],
    ['a deactivated account', 'DEACTIVATED', 401, 'ACCOUNT_DEACTIVATED'],
  ])('[FR-ACC-02] for %s answers %s %s and sends nothing', async (_case, status, http, code) => {
    const h = await accountsHarness();
    const email = status ? (await h.seedUser({ status })).email : 'nobody@example.local';
    const res = await h.post('/auth/resend-verification', { email });
    expect(res.status).toBe(http);
    expect(res.body).toMatchObject({ code });
    expect(await h.sentMail()).toEqual([]);
  });

  it('[NFR-SEC-08] the 4th resend for one email within an hour is 429; one address may ask for many emails', async () => {
    const h = await accountsHarness();
    for (let i = 0; i < 12; i += 1) {
      expect(
        (
          await h.post(
            '/auth/resend-verification',
            { email: `n${String(i)}@example.local` },
            '10.8.8.8',
          )
        ).status,
      ).toBe(404);
    }
    const user = await h.seedUser({ status: 'UNVERIFIED' });
    for (let i = 0; i < 3; i += 1) {
      expect((await h.post('/auth/resend-verification', { email: user.email })).status).toBe(202);
    }
    expect((await h.post('/auth/resend-verification', { email: user.email })).status).toBe(429);
  });
});

describe('[FR-ACC-08] a verified user with no role', () => {
  it('[FR-ACC-08] logs in and reads their profile with no roles', async () => {
    const h = await accountsHarness();
    await signup(h, 'ravi@example.local');
    await verify(h, await linkTokenFor(h, 'ravi@example.local'));
    const jar = await h.loggedIn({
      id: '',
      email: 'ravi@example.local',
      name: '',
      password: NEW_PASSWORD,
    });
    expect((await h.get('/me', jar)).body).toMatchObject({ roles: [], status: 'ACTIVE' });
  });
});
