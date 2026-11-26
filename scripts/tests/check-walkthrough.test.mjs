// The walkthrough check (ADR-0013, amended 2026-11-26): every repository path the
// walkthrough names in backticks must exist, so its answers can't point at code, tests or
// plans that have moved or gone.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { namedPaths, missingPaths } from '../check-walkthrough.mjs';

const doc = [
  '# Walkthrough',
  'The guard is `backend/src/orders/repository.ts` and its test `backend/tests/integrity/order-attacks.test.ts`.',
  'Plans: `docs/query-plans/orders/`. A route: `GET /api/orders` and `/api/orders/{id}`.',
  'A code: `ORDER_LOCKED`; a call: `withTransaction()`; a URL `https://example.com/x.ts`.',
  'A line: `backend/src/db/transaction.ts:42`, an anchor `docs/adr/0015-outstanding-report.md#decision`.',
  'Gone: `backend/src/nowhere.ts`.',
].join('\n');

describe('[NFR-DOC-01] the walkthrough path check', () => {
  it('[NFR-DOC-01] finds the repository paths in backticks, and only those', () => {
    assert.deepEqual(namedPaths(doc), [
      { path: 'backend/src/orders/repository.ts', line: 2 },
      { path: 'backend/tests/integrity/order-attacks.test.ts', line: 2 },
      { path: 'docs/query-plans/orders/', line: 3 },
      { path: 'backend/src/db/transaction.ts', line: 5 },
      { path: 'docs/adr/0015-outstanding-report.md', line: 5 },
      { path: 'backend/src/nowhere.ts', line: 6 },
    ]);
  });

  it('[NFR-DOC-01] reports each path that does not exist, with its line', () => {
    const exists = (path) => path !== 'backend/src/nowhere.ts';
    assert.deepEqual(missingPaths(doc, exists), [{ path: 'backend/src/nowhere.ts', line: 6 }]);
    assert.deepEqual(
      missingPaths(doc, () => true),
      [],
    );
  });
});
