import { afterEach, expect } from 'vitest';
import { readReconciliationSql } from '../../src/db/reconciliation.js';
import type { TestDatabase } from './db.js';
import { secretsIn } from './secrets.js';

// Databases created through trackDatabase() are dropped after each test, once their audit
// rows are checked for secrets (no entry may hold a token, a password hash or the test
// password) and the committed reconciliation query, run as po_app, returns no rows
// (Principle I: after every test suite). A test that breaks an invariant on purpose, below
// every guard, marks its database with plantsViolations().
const created: TestDatabase[] = [];
const brokenOnPurpose = new WeakSet<TestDatabase>();

/** This database holds invariant violations planted on purpose: skip its reconciliation. */
export function plantsViolations(db: TestDatabase): void {
  brokenOnPurpose.add(db);
}

/** The reconciliation's rows as "invariant entity", or none if there are no order tables. */
export async function reconciliationViolations(db: TestDatabase): Promise<string[]> {
  const app = await db.client('po_app');
  const { rows: table } = await app.query<{ exists: boolean }>(
    "SELECT to_regclass('public.purchase_orders') IS NOT NULL AS exists",
  );
  if (table[0]?.exists !== true) return [];
  const { rows } = await app.query<{ invariant: string; entity_id: string }>(
    readReconciliationSql(),
  );
  return rows.map((r) => `${r.invariant} ${r.entity_id}`);
}

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
    const checked = databases.filter((db) => !brokenOnPurpose.has(db));
    const violations = (await Promise.all(checked.map(reconciliationViolations))).flat();
    expect(violations, 'reconciliation rows (stored derived values out of step)').toEqual([]);
  } finally {
    await Promise.all(databases.map((db) => db.drop()));
  }
});
