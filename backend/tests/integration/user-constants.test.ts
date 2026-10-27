import { ROLE_SETS, USER_ROLES, USER_STATUSES } from '@po/contracts';
import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '../support/db.js';
import { trackDatabase } from '../support/setup.js';

// The role and status constants the code uses must be exactly what the users table's
// CHECK constraints allow (migration 0002_users), in the same canonical order.

async function constraintDef(name: string): Promise<string> {
  const db = trackDatabase(await createTestDatabase());
  const admin = await db.client('postgres');
  const { rows } = await admin.query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
    [name],
  );
  return rows[0]?.def ?? '';
}

describe('[FR-ACC-07] user role and status constants match the database', () => {
  it('[FR-ACC-07] ROLE_SETS equals users_roles_valid, set by set and in order', async () => {
    const def = await constraintDef('users_roles_valid');
    const sets = [...def.matchAll(/'\{([^}]*)\}'::text\[\]/g)].map(([, body]) =>
      body ? body.split(',') : [],
    );
    expect(sets.length).toBeGreaterThan(0);
    expect(sets).toEqual(ROLE_SETS.map((set) => [...set]));
  });

  it('[FR-ACC-07] USER_ROLES is exactly the roles the sets use', () => {
    expect([...new Set(ROLE_SETS.flat())].sort()).toEqual([...USER_ROLES].sort());
  });

  it('[FR-ACC-07] USER_STATUSES equals users_status_valid', async () => {
    const def = await constraintDef('users_status_valid');
    const statuses = [...def.matchAll(/'([A-Z_]+)'::text/g)].map(([, value]) => value);
    expect(statuses).toEqual([...USER_STATUSES]);
  });
});
