import { afterEach, expect } from 'vitest';
import type { TestDatabase } from './db.js';
import { secretsIn } from './secrets.js';

// Databases created through trackDatabase() are dropped after each test, once their audit
// rows are checked for secrets: no entry may hold a token, a password hash or the test
// password (SC-007).
const created: TestDatabase[] = [];

export function trackDatabase(db: TestDatabase): TestDatabase {
  created.push(db);
  return db;
}

/** Audit entries holding a secret, as "action: kinds"; none if there is no audit table. */
export async function secretAuditEntries(db: TestDatabase): Promise<string[]> {
  const admin = await db.client('postgres');
  const { rows: table } = await admin.query<{ exists: boolean }>(
    "SELECT to_regclass('public.audit_entries') IS NOT NULL AS exists",
  );
  if (table[0]?.exists !== true) return [];
  const { rows } = await admin.query<{ action: string; entry: string }>(
    'SELECT action, row_to_json(a)::text AS entry FROM audit_entries a',
  );
  return rows.flatMap(({ action, entry }) => {
    const kinds = secretsIn(entry);
    return kinds.length === 0 ? [] : [`${action}: ${kinds.join(', ')}`];
  });
}

afterEach(async () => {
  const databases = created.splice(0);
  try {
    const leaks = (await Promise.all(databases.map(secretAuditEntries))).flat();
    expect(leaks, 'audit entries with a token or password').toEqual([]);
  } finally {
    await Promise.all(databases.map((db) => db.drop()));
  }
});
