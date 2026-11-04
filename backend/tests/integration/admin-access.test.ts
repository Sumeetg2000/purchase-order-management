import { describe, expect, it } from 'vitest';
import { accountsHarness, type AccountsHarness, type CookieJar } from '../support/accounts.js';

// Admin-initiated password reset and the admin's access-request list (ADR-0016; spec US3
// scenarios 7 and 8).

async function asAdmin() {
  const h = await accountsHarness();
  const admin = await h.seedUser({ roles: '{ADMIN}', name: 'Ada Admin' });
  const jar = await h.loggedIn(admin);
  return { h, admin, jar };
}

const UNKNOWN_ID = '0190a6a0-0000-7000-8000-000000000000';

describe('[FR-ADM-03] admin-initiated password reset', () => {
  it.each(['ACTIVE', 'UNVERIFIED', 'DEACTIVATED'])(
    '[FR-ADM-03] a %s user gets the standard reset email; the admin gets 202 and no token',
    async (status) => {
      const { h, jar } = await asAdmin();
      const user = await h.seedUser({ status, roles: status === 'UNVERIFIED' ? '{}' : '{BUYER}' });
      const res = await h.send('post', `/admin/users/${user.id}/reset-password`, jar);
      expect(res.status).toBe(202);
      expect(res.text).toBe('');
      const mail = await h.sentMail();
      expect(mail).toHaveLength(1);
      expect(mail[0]).toMatchObject({ to: user.email, template: 'reset_password' });
      expect(mail[0]?.text).toMatch(/\/reset-password#token=[A-Za-z0-9_-]+/);
    },
  );

  it('[FR-ADM-03] the emailed link sets a new password', async () => {
    const { h, jar } = await asAdmin();
    const user = await h.seedUser();
    await h.send('post', `/admin/users/${user.id}/reset-password`, jar);
    const [mail] = await h.sentMail();
    const token = /#token=([A-Za-z0-9_-]+)/.exec(mail?.text ?? '')?.[1];
    const reset = await h.post('/auth/reset-password', {
      token,
      newPassword: 'a brand new passphrase',
    });
    expect(reset.status).toBe(204);
    expect((await h.login(user.email, 'a brand new passphrase')).status).toBe(200);
  });

  it('[FR-ADM-03] a second send supersedes the first link', async () => {
    const { h, jar } = await asAdmin();
    const user = await h.seedUser();
    await h.send('post', `/admin/users/${user.id}/reset-password`, jar);
    await h.send('post', `/admin/users/${user.id}/reset-password`, jar);
    const [first] = await h.sentMail();
    const token = /#token=([A-Za-z0-9_-]+)/.exec(first?.text ?? '')?.[1];
    const res = await h.post('/auth/reset-password', { token, newPassword: 'another passphrase' });
    expect(res.body).toMatchObject({ code: 'TOKEN_SUPERSEDED' });
  });

  it('[NFR-AUD-04] the send is audited as USER_PASSWORD_RESET_SENT by the admin', async () => {
    const { h, admin, jar } = await asAdmin();
    const user = await h.seedUser();
    await h.send('post', `/admin/users/${user.id}/reset-password`, jar);
    expect(
      await h.query(
        `SELECT actor_user_id, acting_role, entity_type, entity_id, details FROM audit_entries
          WHERE action = 'USER_PASSWORD_RESET_SENT'`,
      ),
    ).toEqual([
      {
        actor_user_id: admin.id,
        acting_role: 'ADMIN',
        entity_type: 'user',
        entity_id: user.id,
        details: {},
      },
    ]);
  });

  it('[FR-ADM-03] the admin themself is 409 SELF_MODIFICATION, another admin 409 ADMIN_NOT_MODIFIABLE', async () => {
    const { h, admin, jar } = await asAdmin();
    const other = await h.seedUser({ roles: '{ADMIN}' });
    const self = await h.send('post', `/admin/users/${admin.id}/reset-password`, jar);
    expect(self.body).toMatchObject({ code: 'SELF_MODIFICATION' });
    const peer = await h.send('post', `/admin/users/${other.id}/reset-password`, jar);
    expect(peer.body).toMatchObject({ code: 'ADMIN_NOT_MODIFIABLE' });
    expect(await h.sentMail()).toEqual([]);
  });

  it('[FR-ADM-03] an unknown user is 404, and a body is refused', async () => {
    const { h, jar } = await asAdmin();
    const missing = await h.send('post', `/admin/users/${UNKNOWN_ID}/reset-password`, jar);
    expect(missing.status).toBe(404);
    const user = await h.seedUser();
    const withBody = await h.send('post', `/admin/users/${user.id}/reset-password`, jar, {
      password: 'set by admin',
    });
    expect(withBody.status).toBe(400);
  });
});

/** A no-role user who sent an access request; returns its id. */
async function openRequest(h: AccountsHarness, message = 'Please add me', name = 'Nia New') {
  const user = await h.seedUser({ roles: '{}', name });
  const jar = await h.loggedIn(user);
  const res = await h.send('post', '/me/access-request', jar, { message });
  if (res.status !== 200) throw new Error(`access request failed: ${JSON.stringify(res.body)}`);
  const [row] = await h.query<{ id: string }>('SELECT id FROM access_requests WHERE user_id = $1', [
    user.id,
  ]);
  return { user, jar, id: row?.id ?? '' };
}

function dismiss(h: AccountsHarness, jar: CookieJar, id: string, body: unknown = {}) {
  return h.send('post', `/admin/access-requests/${id}/dismiss`, jar, body);
}

describe('[FR-ADM-06] admin access-request list', () => {
  it('[FR-ADM-06] lists requests with their user, newest activity first', async () => {
    const { h, jar } = await asAdmin();
    const older = await openRequest(h, 'first', 'Older');
    const newer = await openRequest(h, 'second', 'Newer');
    const res = await h.get('/admin/access-requests', jar);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 1, pageSize: 20, total: 2 });
    const items = (res.body as { items: unknown[] }).items;
    expect(items).toEqual([
      {
        id: newer.id,
        status: 'OPEN',
        message: 'second',
        createdAt: expect.any(String) as unknown,
        updatedAt: expect.any(String) as unknown,
        decidedAt: null,
        adminNote: null,
        user: {
          id: newer.user.id,
          name: 'Newer',
          email: newer.user.email,
          signedUpAt: expect.any(String) as unknown,
        },
      },
      expect.objectContaining({ id: older.id, message: 'first' }),
    ]);
  });

  it('[FR-ADM-06] filters by status; the open count is the badge', async () => {
    const { h, jar } = await asAdmin();
    const kept = await openRequest(h);
    const gone = await openRequest(h);
    await dismiss(h, jar, gone.id);
    const open = await h.get('/admin/access-requests?status=OPEN&pageSize=1', jar);
    expect(open.body).toMatchObject({ total: 1, items: [{ id: kept.id }] });
    const dismissed = await h.get('/admin/access-requests?status=DISMISSED', jar);
    expect(dismissed.body).toMatchObject({ total: 1, items: [{ id: gone.id }] });
  });

  it('[FR-ADM-06] an unknown status is 400; a Buyer gets 403', async () => {
    const { h, jar } = await asAdmin();
    expect((await h.get('/admin/access-requests?status=CLOSED', jar)).status).toBe(400);
    const buyer = await h.loggedIn(await h.seedUser());
    expect((await h.get('/admin/access-requests', buyer)).status).toBe(403);
  });
});

describe('[FR-ADM-06] dismiss an access request', () => {
  it('[FR-ADM-06] dismisses with a trimmed note, which the user then reads', async () => {
    const { h, admin, jar } = await asAdmin();
    const request = await openRequest(h);
    const res = await dismiss(h, jar, request.id, { note: '  Ask your manager first  ' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: request.id,
      status: 'DISMISSED',
      adminNote: 'Ask your manager first',
      decidedAt: h.clock.now().toISOString(),
    });
    expect(
      await h.query('SELECT decided_by FROM access_requests WHERE id = $1', [request.id]),
    ).toEqual([{ decided_by: admin.id }]);
    const own = await h.get('/me/access-request', request.jar);
    expect(own.body).toMatchObject({ status: 'DISMISSED', adminNote: 'Ask your manager first' });
  });

  it('[FR-ADM-06] with no note, or a blank one, no note is kept', async () => {
    const { h, jar } = await asAdmin();
    for (const body of [{}, { note: '   ' }]) {
      const request = await openRequest(h);
      const res = await dismiss(h, jar, request.id, body);
      expect(res.body, JSON.stringify(body)).toMatchObject({
        status: 'DISMISSED',
        adminNote: null,
      });
    }
  });

  it('[NFR-AUD-04] a dismissal is audited with the request and note', async () => {
    const { h, admin, jar } = await asAdmin();
    const request = await openRequest(h);
    await dismiss(h, jar, request.id, { note: 'Not yet' });
    expect(
      await h.query(
        `SELECT actor_user_id, acting_role, entity_type, entity_id, details FROM audit_entries
          WHERE action = 'ACCESS_REQUEST_DISMISSED'`,
      ),
    ).toEqual([
      {
        actor_user_id: admin.id,
        acting_role: 'ADMIN',
        entity_type: 'access_request',
        entity_id: request.id,
        details: { requestId: request.id, note: 'Not yet' },
      },
    ]);
  });

  it('[FR-ADM-06] a request that is not open is 409 ACCESS_REQUEST_NOT_OPEN', async () => {
    const { h, jar } = await asAdmin();
    const request = await openRequest(h);
    await dismiss(h, jar, request.id);
    const again = await dismiss(h, jar, request.id, { note: 'twice' });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'ACCESS_REQUEST_NOT_OPEN' });
  });

  it("[FR-ADM-06] a dismissal waits for the user's row lock, so it can't interleave with their send", async () => {
    const { h, jar } = await asAdmin();
    const request = await openRequest(h);
    // Holds the lock a send takes first, as a send in progress would.
    await h.query('BEGIN');
    await h.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [request.user.id]);
    let finished = false;
    const dismissal = dismiss(h, jar, request.id).then((res) => {
      finished = true;
      return res;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(finished).toBe(false);
    await h.query('COMMIT');
    expect((await dismissal).status).toBe(200);
  });

  it('[FR-ADM-06] after a dismissal the user can open a new request', async () => {
    const { h, jar } = await asAdmin();
    const request = await openRequest(h);
    expect((await dismiss(h, jar, request.id)).status).toBe(200);
    const res = await h.send('post', '/me/access-request', request.jar, { message: 'Again' });
    expect(res.body).toMatchObject({ status: 'OPEN', message: 'Again', adminNote: null });
    expect(await h.query('SELECT status FROM access_requests ORDER BY created_at')).toEqual([
      { status: 'DISMISSED' },
      { status: 'OPEN' },
    ]);
  });

  it('[FR-ADM-06] an unknown request is 404; a note over 500 characters or another field 400', async () => {
    const { h, jar } = await asAdmin();
    expect((await dismiss(h, jar, UNKNOWN_ID)).status).toBe(404);
    const request = await openRequest(h);
    expect((await dismiss(h, jar, request.id, { note: 'x'.repeat(501) })).status).toBe(400);
    expect((await dismiss(h, jar, request.id, { reason: 'x' })).status).toBe(400);
  });
});
