// The load test's unused-index check (specs/008-outstanding-report/research.md R8; owner
// decision 2026-11-26): after a run that also makes every read the UI offers once, an
// index nobody used must be in the committed expected-unused list, with a one-line reason.

/** The SQL that reads each index's scan count since the stack started. */
export const INDEX_USAGE_SQL = `SELECT indexrelname AS index, idx_scan AS scans
  FROM pg_stat_user_indexes WHERE schemaname = 'public' ORDER BY indexrelname`;

const oneLine = (reason) =>
  typeof reason === 'string' && reason.trim() !== '' && !reason.includes('\n');

/**
 * `usage`: [{ index, scans }]; `expected`: [{ index, reason }]. Fails on an unused index
 * the list doesn't name, or an entry with no one-line reason; reports an entry that was
 * used after all.
 */
export function checkIndexUsage(usage, expected) {
  const listed = new Map(expected.map((entry) => [entry.index, entry]));
  const unused = usage.filter((u) => Number(u.scans) === 0).map((u) => u.index);
  const used = new Set(usage.filter((u) => Number(u.scans) > 0).map((u) => u.index));
  const unexpected = unused.filter((index) => !listed.has(index));
  const unexplained = expected.filter((entry) => !oneLine(entry.reason)).map((e) => e.index);
  const expectedButUsed = expected.filter((entry) => used.has(entry.index)).map((e) => e.index);
  return {
    ok: unexpected.length === 0 && unexplained.length === 0,
    unexpected,
    expectedButUsed,
    unexplained,
  };
}
