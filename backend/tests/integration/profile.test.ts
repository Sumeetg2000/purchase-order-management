import { USER_NAME_MAX_LENGTH } from '@po/contracts';
import { describe, expect, it } from 'vitest';
import { accountsHarness } from '../support/accounts.js';

// The caller's own profile edit (ADR-0016 "Profile"; spec US4 scenarios 1–2).

async function loggedInUser(roles = '{BUYER}') {
  const h = await accountsHarness();
  const user = await h.seedUser({ roles, name: 'Asha Rao' });
  const jar = await h.loggedIn(user);
  const patch = (body: unknown) => h.send('patch', '/me', jar, body);
  return { h, user, jar, patch };
}

describe('[FR-USR-01] profile edit', () => {
  it('[FR-USR-01] saves a trimmed name and returns the profile', async () => {
    const { h, user, jar, patch } = await loggedInUser();
    const res = await patch({ name: '  Asha R. Rao  ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: user.id,
      name: 'Asha R. Rao',
      email: user.email,
      roles: ['BUYER'],
      status: 'ACTIVE',
      createdAt: expect.any(String) as unknown,
    });
    expect((await h.get('/me', jar)).body).toMatchObject({ name: 'Asha R. Rao' });
  });

  it('[FR-USR-01] is audited as the user themself, with the name before and after', async () => {
    const { h, user, patch } = await loggedInUser();
    await patch({ name: 'Asha R. Rao' });
    expect(
      await h.query(
        `SELECT actor_user_id, acting_role, entity_type, entity_id, details FROM audit_entries
          WHERE action = 'USER_PROFILE_UPDATED'`,
      ),
    ).toEqual([
      {
        actor_user_id: user.id,
        acting_role: 'SELF',
        entity_type: 'user',
        entity_id: user.id,
        details: { before: 'Asha Rao', after: 'Asha R. Rao' },
      },
    ]);
  });

  it('[FR-USR-01] the same name writes nothing, version included', async () => {
    const { h, user, patch } = await loggedInUser();
    expect((await patch({ name: 'Asha Rao' })).status).toBe(200);
    expect(await h.query('SELECT 1 FROM audit_entries')).toEqual([]);
    expect(await h.query('SELECT version FROM users WHERE id = $1', [user.id])).toEqual([
      { version: 1 },
    ]);
  });

  it("[FR-ADM-02] a new name bumps the user's version, so an admin's older ETag is stale", async () => {
    const { h, user, patch } = await loggedInUser();
    await patch({ name: 'Asha R. Rao' });
    expect(await h.query('SELECT version FROM users WHERE id = $1', [user.id])).toEqual([
      { version: 2 },
    ]);
  });

  it.each([
    ['phone', { name: 'Asha', phone: '+91 98765 43210' }],
    ['email', { name: 'Asha', email: 'other@example.local' }],
    ['roles', { name: 'Asha', roles: ['ADMIN'] }],
    ['status', { name: 'Asha', status: 'ACTIVE' }],
  ])(
    '[FR-USR-01] %s in the body is 400 UNKNOWN_FIELD, and nothing changes',
    async (field, body) => {
      const { h, user, patch } = await loggedInUser();
      const res = await patch(body);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: [{ path: `body.${field}`, code: 'UNKNOWN_FIELD' }],
      });
      expect(await h.query('SELECT name FROM users WHERE id = $1', [user.id])).toEqual([
        { name: 'Asha Rao' },
      ]);
    },
  );

  it('[FR-USR-01] an empty or too long name is 400', async () => {
    const { patch } = await loggedInUser();
    expect((await patch({ name: '   ' })).status).toBe(400);
    expect((await patch({ name: 'n'.repeat(USER_NAME_MAX_LENGTH + 1) })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
  });

  it('[FR-ACC-08] a user with no role can edit their name too', async () => {
    const { patch } = await loggedInUser('{}');
    expect((await patch({ name: 'Nia New' })).body).toMatchObject({ name: 'Nia New', roles: [] });
  });
});
