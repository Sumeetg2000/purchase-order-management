import { describe, expect, it } from 'vitest';
import { LOCKOUT_THRESHOLD, REFRESH_SIBLING_GRACE_SECONDS } from '../../src/auth/constants.js';
import { SECURITY_EVENTS, type SecurityEvent } from '../../src/observability/security-log.js';
import {
  accountsHarness,
  cookiesSet,
  PASSWORD,
  type AccountsHarness,
  type CookieJar,
} from '../support/accounts.js';
import { createCapture, findTokenLeaks, type LogLine } from '../support/log-capture.js';
import { secretResponses } from '../support/response-audit.js';
import { secretsIn } from '../support/secrets.js';

// Security events (ADR-0017's list, FR-029): each account event, triggered through the
// API, is one structured line marked security: true, carrying the request id, address and
// user agent, the user id when known and the session id when one session is concerned,
// and never a token or password. The suite-wide checks (log-capture.ts, response-audit.ts,
// setup.ts) keep every log line, response body and audit row free of secrets.

const WRONG = 'not the right password';
const NEW_PASSWORD = 'a brand new passphrase';
const SECOND_MS = 1_000;

/** The mail events are emitted by the dispatcher, outside a request (mail.test.ts). */
const MAIL_EVENTS: readonly SecurityEvent[] = ['mail_send_failed', 'mail_send_abandoned'];

function securityLines(h: AccountsHarness): LogLine[] {
  return h.logs.filter((line) => line['security'] === true);
}

/** The one line for an event since `from`, with the fields every request event carries. */
function eventLine(h: AccountsHarness, event: SecurityEvent, from = 0): LogLine {
  const lines = securityLines(h)
    .slice(from)
    .filter((line) => line['event'] === event);
  expect(lines, event).toHaveLength(1);
  const line = lines[0] ?? {};
  expect(line['requestId'], `${event} requestId`).toEqual(expect.any(String));
  expect(line['ip'], `${event} ip`).toEqual(expect.any(String));
  expect(line, `${event} userAgent`).toHaveProperty('userAgent');
  return line;
}

async function tokenFrom(h: AccountsHarness, email: string, path: string): Promise<string> {
  const mail = (await h.sentMail()).filter((m) => m.to === email);
  const token = new RegExp(`/${path}#token=([A-Za-z0-9_-]+)`).exec(mail.at(-1)?.text ?? '')?.[1];
  if (!token) throw new Error(`no ${path} link sent to ${email}`);
  return token;
}

async function adminSession(h: AccountsHarness): Promise<CookieJar> {
  return h.loggedIn(await h.seedUser({ roles: '{ADMIN}' }));
}

describe('[NFR-SEC-06] security events for each account event', () => {
  it('[NFR-SEC-06] every event outside the mail ones is triggered by a test below', () => {
    const covered: SecurityEvent[] = [
      'signup',
      'email_verified',
      'email_verification_failed',
      'login_succeeded',
      'login_failed',
      'account_locked',
      'logout',
      'logout_all',
      'refresh_reuse_detected',
      'session_revoked',
      'password_reset_requested',
      'password_reset_completed',
      'password_changed',
      'password_change_failed',
    ];
    expect([...covered, ...MAIL_EVENTS].sort()).toEqual([...SECURITY_EVENTS].sort());
  });

  it('[NFR-SEC-06] email_verification_failed names the user and the reason, never the password', async () => {
    const h = await accountsHarness();
    const email = 'ravi@example.local';
    await h.post('/auth/signup', { name: 'Ravi Kumar', email, password: NEW_PASSWORD });
    const [user] = await h.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
    const token = await tokenFrom(h, email, 'verify-email');
    const guess = 'a wrong verification guess';
    expect((await h.post('/auth/verify-email', { token, password: guess })).status).toBe(400);
    expect(eventLine(h, 'email_verification_failed')).toMatchObject({
      userId: user?.id,
      reason: 'wrong_password',
    });
    expect(JSON.stringify(h.logs)).not.toContain(guess);
  });

  it('[NFR-SEC-06] signup and email_verified carry the new user id', async () => {
    const h = await accountsHarness();
    const email = 'ravi@example.local';
    expect(
      (await h.post('/auth/signup', { name: 'Ravi Kumar', email, password: NEW_PASSWORD })).status,
    ).toBe(202);
    const [user] = await h.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
    expect(eventLine(h, 'signup')).toMatchObject({ userId: user?.id });

    const token = await tokenFrom(h, email, 'verify-email');
    expect((await h.post('/auth/verify-email', { token, password: NEW_PASSWORD })).status).toBe(
      204,
    );
    expect(eventLine(h, 'email_verified')).toMatchObject({ userId: user?.id });
    expect(JSON.stringify(h.logs)).not.toContain(token);
    expect(JSON.stringify(h.logs)).not.toContain(NEW_PASSWORD);
  });

  it('[NFR-SEC-06] login_succeeded names the session; login_failed and account_locked the user and reason', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const res = await h.login(user.email, PASSWORD);
    const [session] = await h.query<{ id: string }>('SELECT id FROM sessions');
    expect(eventLine(h, 'login_succeeded')).toMatchObject({
      userId: user.id,
      sessionId: session?.id,
      ip: '10.0.0.1',
    });

    const from = securityLines(h).length;
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) await h.login(user.email, WRONG);
    const failed = securityLines(h)
      .slice(from)
      .filter((line) => line['event'] === 'login_failed');
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]).toMatchObject({ userId: user.id, reason: 'wrong_password' });
    expect(eventLine(h, 'account_locked', from)).toMatchObject({ userId: user.id });

    const log = JSON.stringify(h.logs);
    expect(log).not.toContain(WRONG);
    for (const value of Object.values(cookiesSet(res))) expect(log).not.toContain(value);
  });

  it('[NFR-SEC-06] logout and logout_all name the user and the session', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const one = await h.loggedIn(user);
    const two = await h.loggedIn(user);
    const sessions = await h.query<{ id: string }>('SELECT id FROM sessions ORDER BY created_at');

    expect((await h.withRefresh('/auth/logout', one)).status).toBe(204);
    expect(eventLine(h, 'logout')).toMatchObject({ userId: user.id });
    expect(sessions.map((s) => s.id)).toContain(eventLine(h, 'logout')['sessionId']);

    expect((await h.withRefresh('/auth/logout-all', two)).status).toBe(204);
    expect(eventLine(h, 'logout_all')).toMatchObject({ userId: user.id });
    expect(sessions.map((s) => s.id)).toContain(eventLine(h, 'logout_all')['sessionId']);
  });

  it('[NFR-SEC-06] refresh reuse logs refresh_reuse_detected and session_revoked by SYSTEM', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const jar = await h.loggedIn(user);
    const [session] = await h.query<{ id: string }>('SELECT id FROM sessions');
    expect((await h.withRefresh('/auth/refresh', jar)).status).toBe(204);
    h.clock.advance((REFRESH_SIBLING_GRACE_SECONDS + 1) * SECOND_MS);
    expect((await h.withRefresh('/auth/refresh', jar)).status).toBe(401);

    expect(eventLine(h, 'refresh_reuse_detected')).toMatchObject({
      userId: user.id,
      sessionId: session?.id,
    });
    expect(eventLine(h, 'session_revoked')).toMatchObject({
      userId: user.id,
      sessionId: session?.id,
      by: 'SYSTEM',
      reason: 'REUSE_DETECTED',
    });
    expect(JSON.stringify(h.logs)).not.toContain(jar['po_refresh']);
  });

  it('[NFR-SEC-06] a user ending one session logs session_revoked by USER with that session', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const here = await h.loggedIn(user);
    await h.loggedIn(user);
    const [other] = await h.query<{ id: string }>(
      'SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1',
    );
    expect((await h.send('delete', `/auth/sessions/${other?.id ?? ''}`, here)).status).toBe(204);
    expect(eventLine(h, 'session_revoked')).toMatchObject({
      userId: user.id,
      sessionId: other?.id,
      by: 'USER',
      reason: 'USER_REVOKED',
    });
  });

  it('[NFR-SEC-06] a password change logs password_changed, password_change_failed and session_revoked by USER', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    const here = await h.loggedIn(user);
    await h.loggedIn(user);
    const [current] = await h.query<{ id: string }>(
      'SELECT id FROM sessions ORDER BY created_at LIMIT 1',
    );

    await h.send('post', '/auth/change-password', here, {
      currentPassword: WRONG,
      newPassword: NEW_PASSWORD,
    });
    expect(eventLine(h, 'password_change_failed')).toMatchObject({
      userId: user.id,
      reason: 'wrong_password',
    });

    const from = securityLines(h).length;
    const changed = await h.send('post', '/auth/change-password', here, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(changed.status).toBe(204);
    expect(eventLine(h, 'password_changed', from)).toMatchObject({
      userId: user.id,
      sessionId: current?.id,
    });
    expect(eventLine(h, 'session_revoked', from)).toMatchObject({
      userId: user.id,
      by: 'USER',
      reason: 'PASSWORD_CHANGED',
    });
    const log = JSON.stringify(h.logs);
    for (const secret of [PASSWORD, WRONG, NEW_PASSWORD]) expect(log).not.toContain(secret);
  });

  it('[NFR-SEC-06] forgot and reset log password_reset_requested by USER and password_reset_completed', async () => {
    const h = await accountsHarness();
    const user = await h.seedUser();
    expect((await h.post('/auth/forgot-password', { email: user.email })).status).toBe(202);
    expect(eventLine(h, 'password_reset_requested')).toMatchObject({
      userId: user.id,
      by: 'USER',
    });

    const token = await tokenFrom(h, user.email, 'reset-password');
    expect(
      (await h.post('/auth/reset-password', { token, newPassword: NEW_PASSWORD })).status,
    ).toBe(204);
    expect(eventLine(h, 'password_reset_completed')).toMatchObject({ userId: user.id });
    const log = JSON.stringify(h.logs);
    expect(log).not.toContain(token);
    expect(log).not.toContain(NEW_PASSWORD);
  });

  it('[NFR-SEC-06] an admin deactivating a user logs session_revoked by ADMIN', async () => {
    const h = await accountsHarness();
    const jar = await adminSession(h);
    const user = await h.seedUser();
    await h.loggedIn(user);
    const from = securityLines(h).length;
    const res = await h.send(
      'patch',
      `/admin/users/${user.id}`,
      jar,
      { isActive: false },
      { 'If-Match': '"1"' },
    );
    expect(res.status).toBe(200);
    expect(eventLine(h, 'session_revoked', from)).toMatchObject({
      userId: user.id,
      by: 'ADMIN',
      reason: 'DEACTIVATED',
    });
  });

  it('[NFR-SEC-06] an admin sending a reset logs password_reset_requested by ADMIN', async () => {
    const h = await accountsHarness();
    const jar = await adminSession(h);
    const user = await h.seedUser();
    const from = securityLines(h).length;
    expect((await h.send('post', `/admin/users/${user.id}/reset-password`, jar)).status).toBe(202);
    expect(eventLine(h, 'password_reset_requested', from)).toMatchObject({
      userId: user.id,
      by: 'ADMIN',
    });
  });
});

describe('[SC-007] the suite-wide secret checks', () => {
  const token = 'A'.repeat(43);
  const hash = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA';

  it('[SC-007] finds a token, a password hash and the test password', () => {
    expect(secretsIn({ note: token })).toEqual(['token']);
    expect(secretsIn({ note: hash })).toEqual(['password hash']);
    expect(secretsIn(`password was ${PASSWORD}`)).toEqual(['password']);
    expect(secretsIn({ id: '0192e4a0-7b1c-7cc0-8a4e-1f2b3c4d5e6f', ip: '10.0.0.1' })).toEqual([]);
  });

  it('[SC-007] a log line with a password hash is a leak, even on the one-time link channel', () => {
    const { logger, lines } = createCapture({ leaksExpected: true });
    logger.info({ oneTimeLink: true, link: `http://x/#token=${token}` }, 'link');
    expect(findTokenLeaks(lines)).toEqual([]);
    logger.info({ oneTimeLink: true, note: hash }, 'hash');
    expect(findTokenLeaks(lines)).toHaveLength(1);
  });

  it('[SC-007] a response body with a token is reported with its route', () => {
    expect(
      secretResponses([
        {
          method: 'GET',
          url: 'http://127.0.0.1/me',
          res: { status: 200, headers: {}, body: { refresh: token } },
        },
        { method: 'GET', url: 'http://127.0.0.1/me', res: { status: 200, headers: {}, body: {} } },
      ]),
    ).toEqual(['GET /me 200: token']);
  });

  it('[SC-007] an audit row with a password hash is reported with its action', async () => {
    const h = await accountsHarness();
    const { secretAuditEntries } = await import('../support/setup.js');
    await h.query('BEGIN');
    await h.query('SET LOCAL session_replication_role = replica');
    await h.query(
      `INSERT INTO audit_entries (occurred_at, actor_type, action, entity_type, entity_id, details)
       VALUES (now(), 'SYSTEM', 'PLANTED', 'user', gen_random_uuid(), $1)`,
      [JSON.stringify({ hash })],
    );
    await h.query('COMMIT');
    expect(await secretAuditEntries(h.db)).toEqual(['PLANTED: password hash']);
    // Removed again so this file's own end-of-test check passes.
    await h.query('BEGIN');
    await h.query('SET LOCAL session_replication_role = replica');
    await h.query("DELETE FROM audit_entries WHERE action = 'PLANTED'");
    await h.query('COMMIT');
  });
});
