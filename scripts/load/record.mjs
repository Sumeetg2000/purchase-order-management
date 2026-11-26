// The load test's run record (specs/008-outstanding-report/research.md R7; ADR-0012,
// amended 2026-11-26): what one run measured, and whether it passed. A run fails on any
// 5xx or timeout, any reconciliation row, or an unexplained unused index; a timing over
// its target is recorded against the target, not failed.

const count = (n) => n.toLocaleString('en-US');

/** Why a run failed; none if it passed. */
export function failuresOf(result) {
  const failures = [];
  const serverErrors = Object.entries(result.statusCounts)
    .filter(([status]) => Number(status) >= 500)
    .reduce((n, [, c]) => n + c, 0);
  if (serverErrors > 0) failures.push(`${String(serverErrors)} responses with a 5xx status`);
  if (result.timeouts > 0) {
    failures.push(
      `${String(result.timeouts)} request${result.timeouts === 1 ? '' : 's'} timed out`,
    );
  }
  if (result.reconciliationRows > 0) {
    failures.push(`reconciliation returned ${String(result.reconciliationRows)} rows`);
  }
  for (const index of result.indexes.unexpected) {
    failures.push(`unused index not in the expected list: ${index}`);
  }
  for (const index of result.indexes.unexplained) {
    failures.push(`expected-unused entry without a one-line reason: ${index}`);
  }
  return failures;
}

function duration(ms) {
  const seconds = Math.round(ms / 1000);
  return `${String(Math.floor(seconds / 60))} min ${String(seconds % 60)} s`;
}

/** The run as docs/perf/load-run.md records it. */
export function renderRunRecord(result) {
  const failures = failuresOf(result);
  const lines = [
    '# Load test run',
    '',
    `The brief's §8 load test (ADR-0012, amended 2026-11-26): one recorded run of`,
    '`npm run load` on the isolated `po-load` stack. Orders were raised through the HTTP',
    'API by about 20 virtual users; their ages were then spread by the guarded age shift',
    '(audit entries keep their real times).',
    '',
    `**Result: ${failures.length === 0 ? 'pass' : 'fail'}**`,
    ...failures.map((f) => `- ${f}`),
    '',
    `- Date: ${result.date}`,
    `- Commit: ${result.commit}`,
    `- Duration: ${duration(result.durationMs)}`,
    `- Dataset: ${Object.entries(result.dataset)
      .map(([k, v]) => `${count(v)} ${k}`)
      .join(', ')}`,
    '',
    '## Responses by status',
    '',
    '| Status | Count |',
    '|---|---|',
    ...Object.entries(result.statusCounts)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([status, n]) => `| ${status} | ${count(n)} |`),
    `| timed out | ${count(result.timeouts)} |`,
    '',
    '## Report timings (p95, 50 timed after 3 warm-up)',
    '',
    '| Request | p95 | Target | |',
    '|---|---|---|---|',
    ...Object.entries(result.timings).map(
      ([name, t]) =>
        `| ${name} | ${String(t.p95)} ms | ${String(t.target)} ms | ${t.p95 <= t.target ? 'within' : 'over'} |`,
    ),
    '',
    `Reconciliation: ${String(result.reconciliationRows)} rows.`,
    '',
    result.indexes.unexpected.length === 0 && result.indexes.unexplained.length === 0
      ? 'Unused indexes: all expected (`scripts/load/expected-unused-indexes.json`).'
      : `Unused indexes not explained: ${[...result.indexes.unexpected, ...result.indexes.unexplained].join(', ')}.`,
    ...(result.indexes.expectedButUsed.length > 0
      ? [`Listed as unused but used in this run: ${result.indexes.expectedButUsed.join(', ')}.`]
      : []),
    '',
    'The plan for outstanding orders by age on this data:',
    '[`docs/query-plans/load/outstanding-by-age.txt`](../query-plans/load/outstanding-by-age.txt).',
    '',
  ];
  return lines.join('\n');
}
