import { describe, expect, it } from 'vitest';
import { accountsHarness, type AccountsHarness, type CookieJar } from '../support/accounts.js';

// Admin user management (ADR-0016 "Admin user management"; spec US3 scenarios 1–6 and 9).

async function asAdmin() {
  const h = await accountsHarness();
  const admin = await h.seedUser({ roles: '{ADMIN}', name: 'Ada Admin' });
  const jar = await h.loggedIn(admin);
  return { h, admin, jar };
}

function patchUser(
  h: AccountsHarness,
  jar: CookieJar,
  id: string,
  body: unknown,
  ifMatch: string | null = '"1"',
) {
  return h.send(
    'patch',
    `/admin/users/${id}`,
    jar,
    body,
    ifMatch === null ? {} : { 'If-Match': ifMatch },
  );
}

async function auditOf(h: AccountsHarness, action: string) {
  return h.query<{
    actor_user_id: string;
    acting_role: string;
    entity_id: string;
    details: unknown;
  }>(
    `SELECT actor_user_id, acting_role, entity_id, details FROM audit_entries
      WHERE action = $1 ORDER BY id`,
    [action],
  );
}

async function sessionsOf(h: AccountsHarness, userId: string) {
  return h.query<{ revoke_reason: string | null }>(
    'SELECT revoke_reason FROM sessions WHERE user_id = $1',
    [userId],
  );
}

describe('[FR-ADM-01] admin user list', () => {
  it('[FR-ADM-01] lists users sorted by name then id, with role, status and last login', async () => {
    const { h, admin } = await asAdmin();
    const bea = await h.seedUser({ name: 'Bea Buyer' });
    const cal = await h.seedUser({
      roles: '{APPROVER}',
      name: 'Cal Approver',
      status: 'DEACTIVATED',
    });
    const jar = await h.loggedIn(admin);
    const res = await h.get('/admin/users', jar);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      items: [
        {
          id: admin.id,
          name: 'Ada Admin',
          email: admin.email,
          roles: ['ADMIN'],
          status: 'ACTIVE',
          lastLoginAt: h.clock.now().toISOString(),
        },
        {
          id: bea.id,
          name: 'Bea Buyer',
          email: bea.email,
          roles: ['BUYER'],
          status: 'ACTIVE',
          lastLoginAt: null,
        },
        {
          id: cal.id,
          name: 'Cal Approver',
          email: cal.email,
          roles: ['APPROVER'],
          status: 'DEACTIVATED',
          lastLoginAt: null,
        },
      ],
      page: 1,
      pageSize: 20,
      total: 3,
    });
  });

  it('[FR-ADM-01] filters by role, including users with no role', async () => {
    const { h, jar } = await asAdmin();
    const buyer = await h.seedUser({ name: 'Buyer' });
    const dual = await h.seedUser({ roles: '{BUYER,APPROVER}', name: 'Dual' });
    const approver = await h.seedUser({ roles: '{APPROVER}', name: 'Approver' });
    const none = await h.seedUser({ roles: '{}', name: 'Nobody' });
    const ids = async (query: string) =>
      ((await h.get(`/admin/users?${query}`, jar)).body as { items: { id: string }[] }).items.map(
        (u) => u.id,
      );
    expect(await ids('role=BUYER')).toEqual([buyer.id, dual.id]);
    expect(await ids('role=APPROVER')).toEqual([approver.id, dual.id]);
    expect(await ids('role=NONE')).toEqual([none.id]);
  });

  it('[FR-ADM-01] filters by status', async () => {
    const { h, jar } = await asAdmin();
    const gone = await h.seedUser({ name: 'Gone', status: 'DEACTIVATED' });
    const fresh = await h.seedUser({ roles: '{}', name: 'Fresh', status: 'UNVERIFIED' });
    const res = await h.get('/admin/users?status=DEACTIVATED', jar);
    expect((res.body as { items: { id: string }[] }).items.map((u) => u.id)).toEqual([gone.id]);
    const unverified = await h.get('/admin/users?status=UNVERIFIED', jar);
    expect((unverified.body as { total: number }).total).toBe(1);
    expect(unverified.body).toMatchObject({ items: [{ id: fresh.id }] });
  });

  it('[FR-ADM-01] q is a case-insensitive prefix of the name or the email, never a substring', async () => {
    const { h, jar } = await asAdmin();
    const priya = await h.seedUser({ name: 'Priya Shah' });
    await h.seedUser({ name: 'Anand Priyadarshi' });
    const names = async (q: string) =>
      (
        (await h.get(`/admin/users?q=${encodeURIComponent(q)}`, jar)).body as {
          items: { name: string }[];
        }
      ).items.map((u) => u.name);
    expect(await names('pRiY')).toEqual(['Priya Shah']);
    expect(await names(priya.email.slice(0, 5).toUpperCase())).toEqual(['Priya Shah']);
    expect(await names('shah')).toEqual([]);
  });

  it('[FR-ADM-01] q matches % and _ literally', async () => {
    const { h, jar } = await asAdmin();
    await h.seedUser({ name: '100% Bea' });
    await h.seedUser({ name: '1000 Cal' });
    const res = await h.get(`/admin/users?q=${encodeURIComponent('100%')}`, jar);
    expect((res.body as { items: { name: string }[] }).items.map((u) => u.name)).toEqual([
      '100% Bea',
    ]);
    const underscore = await h.get('/admin/users?q=1_0', jar);
    expect((underscore.body as { total: number }).total).toBe(0);
  });

  it('[FR-ADM-01] pages are stable across equal names, and the total counts every match', async () => {
    const { h, jar } = await asAdmin();
    const twins = [];
    for (let i = 0; i < 5; i += 1) twins.push(await h.seedUser({ name: 'Sam Same' }));
    const expected = twins.map((u) => u.id).sort();
    const seen: string[] = [];
    for (const page of [1, 2, 3]) {
      const res = await h.get(`/admin/users?q=sam&pageSize=2&page=${String(page)}`, jar);
      expect(res.body).toMatchObject({ page, pageSize: 2, total: 5 });
      seen.push(...(res.body as { items: { id: string }[] }).items.map((u) => u.id));
    }
    expect(seen).toEqual(expected);
    const past = await h.get('/admin/users?q=sam&pageSize=2&page=4', jar);
    expect(past.body).toMatchObject({ items: [], total: 5 });
  });

  it('[FR-ADM-01] an unknown filter value or field is 400', async () => {
    const { h, jar } = await asAdmin();
    for (const query of ['role=OWNER', 'status=LOCKED', 'pageSize=51', 'sort=email']) {
      const res = await h.get(`/admin/users?${query}`, jar);
      expect(res.status, query).toBe(400);
    }
  });

  it('[FR-ADM-01] a Buyer gets 403 FORBIDDEN, a user with no role 403 NO_ROLE_ASSIGNED', async () => {
    const h = await accountsHarness();
    const buyer = await h.loggedIn(await h.seedUser());
    expect((await h.get('/admin/users', buyer)).body).toMatchObject({ code: 'FORBIDDEN' });
    const none = await h.loggedIn(await h.seedUser({ roles: '{}' }));
    expect((await h.get('/admin/users', none)).body).toMatchObject({ code: 'NO_ROLE_ASSIGNED' });
  });
});

describe('[FR-ADM-01] admin user detail', () => {
  it('[FR-ADM-01] returns the user with their version as ETag, and no open-order counts yet', async () => {
    const { h, jar } = await asAdmin();
    const bea = await h.seedUser({ name: 'Bea Buyer' });
    const res = await h.get(`/admin/users/${bea.id}`, jar);
    expect(res.status).toBe(200);
    expect(res.get('ETag')).toBe('"1"');
    expect(res.body).toEqual({
      id: bea.id,
      name: 'Bea Buyer',
      email: bea.email,
      roles: ['BUYER'],
      status: 'ACTIVE',
      lastLoginAt: null,
      createdAt: expect.any(String) as unknown,
      version: 1,
    });
  });

  it('[FR-ADM-01] an unknown id is 404, a malformed one 400', async () => {
    const { h, jar } = await asAdmin();
    const missing = await h.get('/admin/users/0190a6a0-0000-7000-8000-000000000000', jar);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'NOT_FOUND' });
    expect((await h.get('/admin/users/not-a-uuid', jar)).status).toBe(400);
  });
});

describe('[FR-ADM-02] admin user update: input and version', () => {
  it('[FR-ADM-02] a missing If-Match is 400 VERSION_REQUIRED; a stale one 409 VERSION_CONFLICT', async () => {
    const { h, jar } = await asAdmin();
    const bea = await h.seedUser();
    const missing = await patchUser(h, jar, bea.id, { roles: ['APPROVER'] }, null);
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'header.if-match', code: 'VERSION_REQUIRED' }],
    });
    const stale = await patchUser(h, jar, bea.id, { roles: ['APPROVER'] }, '"2"');
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(await h.query('SELECT roles FROM users WHERE id = $1', [bea.id])).toEqual([
      { roles: ['BUYER'] },
    ]);
  });

  it.each([
    ['no role', []],
    ['Admin', ['ADMIN']],
    ['Admin with Buyer', ['BUYER', 'ADMIN']],
    ['a repeated role', ['BUYER', 'BUYER']],
  ])('[FR-ACC-07] assigning %s is 400 INVALID_ROLE_SET', async (_label, roles) => {
    const { h, jar } = await asAdmin();
    const bea = await h.seedUser();
    const res = await patchUser(h, jar, bea.id, { roles });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'body.roles', code: 'INVALID_ROLE_SET' }],
    });
  });

  it('[FR-ADM-02] any other field, or neither field, is 400', async () => {
    const { h, jar } = await asAdmin();
    const bea = await h.seedUser();
    for (const body of [{ roles: ['BUYER'], name: 'New' }, { email: 'x@example.local' }, {}]) {
      const res = await patchUser(h, jar, bea.id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('[FR-ADM-02] an unknown user is 404', async () => {
    const { h, jar } = await asAdmin();
    const res = await patchUser(h, jar, '0190a6a0-0000-7000-8000-000000000000', {
      roles: ['BUYER'],
    });
    expect(res.status).toBe(404);
  });
});

describe('[FR-ADM-02] admin user update: guards, in order', () => {
  it('[FR-ADM-02] the admin themself is 409 SELF_MODIFICATION', async () => {
    const { h, admin, jar } = await asAdmin();
    const res = await patchUser(h, jar, admin.id, { isActive: false });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'SELF_MODIFICATION' });
  });

  it('[FR-ADM-02] another admin is 409 ADMIN_NOT_MODIFIABLE, before a stale version', async () => {
    const { h, jar } = await asAdmin();
    const other = await h.seedUser({ roles: '{ADMIN}' });
    const res = await patchUser(h, jar, other.id, { isActive: false }, '"9"');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'ADMIN_NOT_MODIFIABLE' });
  });

  it.each([true, false])(
    '[FR-ADM-02] isActive %s on an unverified user is 409 USER_UNVERIFIED',
    async (isActive) => {
      const { h, jar } = await asAdmin();
      const fresh = await h.seedUser({ roles: '{}', status: 'UNVERIFIED' });
      const res = await patchUser(h, jar, fresh.id, { isActive });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'USER_UNVERIFIED' });
      expect(await h.query('SELECT status FROM users WHERE id = $1', [fresh.id])).toEqual([
        { status: 'UNVERIFIED' },
      ]);
    },
  );

  it('[FR-ADM-02] USER_UNVERIFIED comes before a stale version', async () => {
    const { h, jar } = await asAdmin();
    const fresh = await h.seedUser({ roles: '{}', status: 'UNVERIFIED' });
    const res = await patchUser(h, jar, fresh.id, { isActive: true }, '"8"');
    expect(res.body).toMatchObject({ code: 'USER_UNVERIFIED' });
  });

  it('[FR-ADM-02] a guard comes before a stale version', async () => {
    const { h, admin, jar } = await asAdmin();
    const res = await patchUser(h, jar, admin.id, { roles: ['BUYER'] }, '"7"');
    expect(res.body).toMatchObject({ code: 'SELF_MODIFICATION' });
  });
});

describe('[FR-ADM-02] admin user update: changes', () => {
  it('[FR-ACC-07] a role change saves the canonical set, bumps the version and returns the user', async () => {
    const { h, jar } = await asAdmin();
    const bea = await h.seedUser();
    const res = await patchUser(h, jar, bea.id, { roles: ['APPROVER', 'BUYER'] });
    expect(res.status).toBe(200);
    expect(res.get('ETag')).toBe('"2"');
    expect(res.body).toMatchObject({ id: bea.id, roles: ['BUYER', 'APPROVER'], version: 2 });
    expect(await h.query('SELECT roles, version FROM users WHERE id = $1', [bea.id])).toEqual([
      { roles: ['BUYER', 'APPROVER'], version: 2 },
    ]);
  });

  it('[NFR-AUD-04] a role change is audited by the admin with roles before and after', async () => {
    const { h, admin, jar } = await asAdmin();
    const bea = await h.seedUser();
    await h.loggedIn(bea);
    await patchUser(h, jar, bea.id, { roles: ['APPROVER'] });
    expect(await auditOf(h, 'USER_ROLES_CHANGED')).toEqual([
      {
        actor_user_id: admin.id,
        acting_role: 'ADMIN',
        entity_id: bea.id,
        details: { before: ['BUYER'], after: ['APPROVER'], sessionsRevoked: 1 },
      },
    ]);
  });

  it('[NFR-SEC-03] a role change ends every session: the next call and refresh say ROLES_CHANGED', async () => {
    const { h, jar } = await asAdmin();
    const bea = await h.seedUser();
    const beaJar = await h.loggedIn(bea);
    await h.loggedIn(bea);
    await patchUser(h, jar, bea.id, { roles: ['APPROVER'] });
    expect(await sessionsOf(h, bea.id)).toEqual([
      { revoke_reason: 'ROLES_CHANGED' },
      { revoke_reason: 'ROLES_CHANGED' },
    ]);
    const next = await h.get('/me', beaJar);
    expect(next.status).toBe(401);
    expect(next.body).toMatchObject({ code: 'SESSION_REVOKED', reason: 'ROLES_CHANGED' });
    const refresh = await h.withRefresh('/auth/refresh', beaJar);
    expect(refresh.body).toMatchObject({ code: 'SESSION_REVOKED', reason: 'ROLES_CHANGED' });
    const again = await h.loggedIn(bea);
    expect((await h.get('/me', again)).body).toMatchObject({ roles: ['APPROVER'] });
  });

  it('[FR-ADM-06] a first role resolves the open access request in the same change', async () => {
    const { h, admin, jar } = await asAdmin();
    const none = await h.seedUser({ roles: '{}' });
    const noneJar = await h.loggedIn(none);
    const sent = await h.send('post', '/me/access-request', noneJar, { message: 'Buyer please' });
    expect(sent.status).toBe(200);
    await patchUser(h, jar, none.id, { roles: ['BUYER'] });
    const [request] = await h.query<{ id: string }>(
      `SELECT id, status, decided_by, decided_at IS NOT NULL AS decided, admin_note
         FROM access_requests`,
    );
    expect(request).toMatchObject({
      status: 'RESOLVED',
      decided_by: admin.id,
      decided: true,
      admin_note: null,
    });
    expect(await auditOf(h, 'ACCESS_REQUEST_RESOLVED')).toEqual([
      {
        actor_user_id: admin.id,
        acting_role: 'ADMIN',
        entity_id: request?.id,
        details: { requestId: request?.id, roles: ['BUYER'] },
      },
    ]);
  });

  it('[FR-ADM-02] deactivation ends every session; the next call and login get ACCOUNT_DEACTIVATED', async () => {
    const { h, jar } = await asAdmin();
    const bea = await h.seedUser();
    const beaJar = await h.loggedIn(bea);
    const res = await patchUser(h, jar, bea.id, { isActive: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'DEACTIVATED', version: 2 });
    expect(await sessionsOf(h, bea.id)).toEqual([{ revoke_reason: 'DEACTIVATED' }]);
    expect(
      await h.query('SELECT deactivated_at IS NOT NULL AS set FROM users WHERE id = $1', [bea.id]),
    ).toEqual([{ set: true }]);
    expect((await h.get('/me', beaJar)).body).toMatchObject({ code: 'ACCOUNT_DEACTIVATED' });
    const login = await h.login(bea.email, bea.password);
    expect(login.status).toBe(401);
    expect(login.body).toMatchObject({ code: 'ACCOUNT_DEACTIVATED' });
  });

  it('[NFR-AUD-04] deactivation and reactivation are audited with status before and after', async () => {
    const { h, admin, jar } = await asAdmin();
    const bea = await h.seedUser();
    await h.loggedIn(bea);
    await patchUser(h, jar, bea.id, { isActive: false });
    const back = await patchUser(h, jar, bea.id, { isActive: true }, '"2"');
    expect(back.body).toMatchObject({ status: 'ACTIVE', version: 3 });
    expect(await h.query('SELECT deactivated_at FROM users WHERE id = $1', [bea.id])).toEqual([
      { deactivated_at: null },
    ]);
    const entry = (before: string, after: string, sessionsRevoked: number) => ({
      actor_user_id: admin.id,
      acting_role: 'ADMIN',
      entity_id: bea.id,
      details: { before, after, sessionsRevoked },
    });
    expect(await auditOf(h, 'USER_DEACTIVATED')).toEqual([entry('ACTIVE', 'DEACTIVATED', 1)]);
    expect(await auditOf(h, 'USER_REACTIVATED')).toEqual([entry('DEACTIVATED', 'ACTIVE', 0)]);
    expect((await h.login(bea.email, bea.password)).status).toBe(200);
  });

  it('[FR-ADM-06] deactivation dismisses the open access request with "Account deactivated"', async () => {
    const { h, jar } = await asAdmin();
    const none = await h.seedUser({ roles: '{}' });
    const noneJar = await h.loggedIn(none);
    await h.send('post', '/me/access-request', noneJar, { message: 'Buyer please' });
    await patchUser(h, jar, none.id, { isActive: false });
    const [request] = await h.query<{ id: string }>(
      'SELECT id, status, admin_note, decided_by FROM access_requests',
    );
    expect(request).toMatchObject({
      status: 'DISMISSED',
      admin_note: 'Account deactivated',
      decided_by: null,
    });
    expect(await auditOf(h, 'ACCESS_REQUEST_DISMISSED')).toMatchObject([
      { details: { requestId: request?.id, note: 'Account deactivated' } },
    ]);
  });

  it('[FR-ADM-02] roles and status in one request: one version, one entry per change', async () => {
    const { h, jar } = await asAdmin();
    const bea = await h.seedUser({ status: 'DEACTIVATED' });
    const res = await patchUser(h, jar, bea.id, { roles: ['APPROVER'], isActive: true });
    expect(res.body).toMatchObject({ roles: ['APPROVER'], status: 'ACTIVE', version: 2 });
    expect(await auditOf(h, 'USER_ROLES_CHANGED')).toHaveLength(1);
    expect(await auditOf(h, 'USER_REACTIVATED')).toHaveLength(1);
  });

  it('[FR-ADM-02] a role change on a deactivated user keeps when they were deactivated', async () => {
    const { h, jar } = await asAdmin();
    const bea = await h.seedUser({ status: 'DEACTIVATED' });
    const [before] = await h.query<{ deactivated_at: Date }>(
      'SELECT deactivated_at FROM users WHERE id = $1',
      [bea.id],
    );
    const res = await patchUser(h, jar, bea.id, { roles: ['APPROVER'] });
    expect(res.body).toMatchObject({ roles: ['APPROVER'], status: 'DEACTIVATED' });
    expect(await h.query('SELECT deactivated_at FROM users WHERE id = $1', [bea.id])).toEqual([
      { deactivated_at: before?.deactivated_at },
    ]);
  });

  it('[FR-ADM-02] a no-op writes nothing: same version, no audit entry, no session ends', async () => {
    const { h, jar } = await asAdmin();
    const bea = await h.seedUser({ roles: '{BUYER,APPROVER}' });
    await h.loggedIn(bea);
    const res = await patchUser(h, jar, bea.id, { roles: ['APPROVER', 'BUYER'], isActive: true });
    expect(res.status).toBe(200);
    expect(res.get('ETag')).toBe('"1"');
    expect(res.body).toMatchObject({ version: 1 });
    expect(
      await h.query(`SELECT action FROM audit_entries WHERE entity_id = $1`, [bea.id]),
    ).toEqual([]);
    expect(await sessionsOf(h, bea.id)).toEqual([{ revoke_reason: null }]);
  });

  it('[FR-ADM-02] a no-op with a stale version is still 409 VERSION_CONFLICT', async () => {
    const { h, jar } = await asAdmin();
    const bea = await h.seedUser();
    const res = await patchUser(h, jar, bea.id, { roles: ['BUYER'] }, '"3"');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'VERSION_CONFLICT' });
  });
});
