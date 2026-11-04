import { describe, expect, it, vi } from 'vitest';
import { HOUR_SECONDS, SECOND_MS } from '../../src/lib/time.js';
import { RATE_LIMIT_BUCKETS } from '../../src/rate-limit/buckets.js';
import { accountsHarness, PASSWORD, type AccountsHarness } from '../support/accounts.js';

// Forgot-password (ADR-0017 "Passwords", "Rate limits", "Email"; spec US5 scenarios 1, 4).

const NEW_PASSWORD = 'a brand new passphrase';
const FORGOT_LIMIT = RATE_LIMIT_BUCKETS.find((b) => b.name === 'forgot-email')?.limit ?? 0;

const forgot = (h: AccountsHarness, email: string, ip = '10.0.0.1') =>
  h.post('/auth/forgot-password', { email }, ip);

const reset = (h: AccountsHarness, token: string) =>
  h.post('/auth/reset-password', { token, newPassword: NEW_PASSWORD });

/** The token in the newest reset email to an address. */
async function resetTokenFor(h: AccountsHarness, email: string): Promise<string> {
  const mail = (await h.sentMail()).filter(
    (m) => m.to === email && m.template === 'reset_password',
  );
  const token = /\/reset-password#token=([A-Za-z0-9_-]+)/.exec(mail.at(-1)?.text ?? '')?.[1];
  if (!token) throw new Error(`no reset link sent to ${email}`);
  return token;
}

describe('[FR-ACC-05] forgot-password', () => {
  it('[FR-ACC-05] emails a reset link for an active account; the link sets a new password', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const res = await forgot(h, user.email.toUpperCase());
    expect(res.status).toBe(202);
    expect(res.text).toBe('');
    const [mail] = await h.sentMail();
    expect(mail).toMatchObject({ template: 'reset_password', to: user.email });
    expect(mail?.text).toMatch(
      /^http:\/\/localhost:8080\/reset-password#token=[A-Za-z0-9_-]{43}$/m,
    );
    expect((await reset(h, await resetTokenFor(h, user.email))).status).toBe(204);
    expect((await h.login(user.email, NEW_PASSWORD)).status).toBe(200);
  });

  it('[FR-ACC-05] changes nothing by itself: the password works and every session stays', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const jar = await h.loggedIn(user);
    await forgot(h, user.email);
    expect((await h.get('/me', jar)).status).toBe(200);
    expect((await h.login(user.email, PASSWORD)).status).toBe(200);
  });

  it('[FR-ACC-05] an unverified account gets a link, and the reset activates it', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser({ status: 'UNVERIFIED' });
    expect((await forgot(h, user.email)).status).toBe(202);
    await reset(h, await resetTokenFor(h, user.email));
    expect(await h.query('SELECT status FROM users WHERE id = $1', [user.id])).toEqual([
      { status: 'ACTIVE' },
    ]);
  });

  it('[FR-ACC-05] an account whose password was never set gets a link (an expired bootstrap link)', async () => {
    const h = await accountsHarness();
    const admin = await h.seedUser({ roles: '{ADMIN}', password: null });
    expect((await forgot(h, admin.email)).status).toBe(202);
    await reset(h, await resetTokenFor(h, admin.email));
    expect((await h.login(admin.email, NEW_PASSWORD)).status).toBe(200);
  });

  it.each([
    ['an unknown email', 404, 'ACCOUNT_NOT_FOUND', undefined],
    ['a deactivated account', 401, 'ACCOUNT_DEACTIVATED', 'DEACTIVATED'],
  ])('[FR-ACC-05] for %s answers %i %s and sends nothing', async (_case, http, code, status) => {
    const h = await accountsHarness();
    const email = status ? (await h.seedUser({ status })).email : 'nobody@example.local';
    const res = await forgot(h, email);
    expect(res.status).toBe(http);
    expect(res.body).toMatchObject({ code });
    expect(await h.sentMail()).toEqual([]);
    expect(await h.query('SELECT count(*)::int AS n FROM one_time_tokens')).toEqual([{ n: 0 }]);
  });

  it('[FR-ACC-03] a new link supersedes the earlier one, an admin-sent one included', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const fromAdmin = await h.issue(user.id);
    await forgot(h, user.email);
    const first = await resetTokenFor(h, user.email);
    await forgot(h, user.email);
    const second = await resetTokenFor(h, user.email);
    expect(second).not.toBe(first);
    expect((await reset(h, fromAdmin)).body).toMatchObject({ code: 'TOKEN_SUPERSEDED' });
    expect((await reset(h, first)).body).toMatchObject({ code: 'TOKEN_SUPERSEDED' });
    expect((await reset(h, second)).status).toBe(204);
  });

  it('[FR-ACC-03] leaves an unused verification link working', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser({ status: 'UNVERIFIED' });
    const verification = await h.issue(user.id, 'VERIFY_EMAIL');
    await forgot(h, user.email);
    expect((await h.post('/auth/verify-email', { token: verification })).status).toBe(204);
  });

  it('[NFR-SEC-06] logs the request as a security event, without the address', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const res = await forgot(h, user.email);
    const events = h.logs.filter((line) => line['security'] === true);
    expect(events).toEqual([
      expect.objectContaining({
        event: 'password_reset_requested',
        userId: user.id,
        by: 'USER',
        requestId: res.headers['x-request-id'],
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain(user.email);
  });

  it('[NFR-OPS-04] a mail failure is logged, and the request still succeeds', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    vi.spyOn(h.mailer, 'send').mockRejectedValueOnce(new Error('SMTP refused the message'));
    expect((await forgot(h, user.email)).status).toBe(202);
    await h.sentMail();
    expect(h.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'mail_send_failed', template: 'reset_password' }),
      ]),
    );
    // The link was issued: asking again supersedes it and sends a working one.
    await forgot(h, user.email);
    expect((await reset(h, await resetTokenFor(h, user.email))).status).toBe(204);
  });
});

describe('[NFR-SEC-08] forgot-password rate limit', () => {
  it('[NFR-SEC-08] the 4th request for one email within an hour is 429 with Retry-After, and sends nothing', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    for (let i = 0; i < FORGOT_LIMIT; i += 1) {
      expect((await forgot(h, user.email, `10.0.0.${String(i + 1)}`)).status).toBe(202);
    }
    const over = await forgot(h, user.email.toUpperCase(), '10.9.9.9');
    expect(over.status).toBe(429);
    expect(over.body).toMatchObject({ code: 'RATE_LIMITED' });
    expect(Number(over.get('Retry-After'))).toBeGreaterThan(0);
    expect(Number(over.get('Retry-After'))).toBeLessThanOrEqual(HOUR_SECONDS);
    expect(await h.sentMail()).toHaveLength(FORGOT_LIMIT);
    // The refused request issued nothing: the last link sent still works.
    expect((await reset(h, await resetTokenFor(h, user.email))).status).toBe(204);
    // The window passes: the email may ask again.
    h.clock.advance(HOUR_SECONDS * SECOND_MS);
    expect((await forgot(h, user.email)).status).toBe(202);
  });

  it('[NFR-SEC-08] has no per-address limit: one address may ask for many emails', async () => {
    const h = await accountsHarness();
    for (let i = 0; i < 12; i += 1) {
      expect((await forgot(h, `n${String(i)}@example.local`, '10.8.8.8')).status).toBe(404);
    }
    const user = await h.seedUser();
    expect((await forgot(h, user.email, '10.8.8.8')).status).toBe(202);
  });

  it('[NFR-SEC-08] counts apart from resend-verification', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser({ status: 'UNVERIFIED' });
    for (let i = 0; i < FORGOT_LIMIT; i += 1) {
      await h.post('/auth/resend-verification', { email: user.email });
    }
    expect((await forgot(h, user.email)).status).toBe(202);
  });
});
