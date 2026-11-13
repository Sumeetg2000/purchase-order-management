import { readFileSync } from 'node:fs';

// The committed reconciliation query (Principle I, data-model.md): every row it returns is
// a stored derived value that disagrees with what it is derived from. Tests run it after
// every test database and attack; seeds run it after seeding.

const RECONCILIATION_SQL = new URL('./reconciliation.sql', import.meta.url);

export interface ReconciliationRow {
  invariant: string;
  entity_id: string;
  detail: string;
}

/** The query's text, read from the committed file. */
export function readReconciliationSql(): string {
  return readFileSync(RECONCILIATION_SQL, 'utf8');
}

/** Fails when any stored derived value disagrees with what it is derived from. */
export async function assertReconciled(db: {
  $queryRawUnsafe: <T>(sql: string) => Promise<T>;
}): Promise<void> {
  const rows = await db.$queryRawUnsafe<ReconciliationRow[]>(readReconciliationSql());
  if (rows.length > 0) {
    const shown = rows.slice(0, 5).map((r) => `${r.invariant} ${r.entity_id}`);
    throw new Error(`reconciliation found ${String(rows.length)} rows: ${shown.join(', ')}`);
  }
}
