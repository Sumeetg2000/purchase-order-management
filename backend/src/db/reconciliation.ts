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
