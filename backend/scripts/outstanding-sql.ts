import { AGE_BUCKETS } from '@po/contracts';
import { outstandingReportSql } from '../src/reports/repository.js';

// Prints the outstanding report's SQL for one age band, values inlined, as
// `EXPLAIN (ANALYZE, BUFFERS)` statements for the page (with its count) and the count
// alone: the load test (scripts/load/load.mjs) runs them in the po-load stack's database
// to commit the brief's §8 plan for outstanding orders by age on its data. The SQL is the
// API's own (src/reports/repository.ts), as an Admin sees it.
//
// Usage: tsx scripts/outstanding-sql.ts --as-of YYYY-MM-DD [--bucket OVER_90]

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i === -1 ? fallback : process.argv[i + 1];
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

/** The statement with its $n placeholders replaced by SQL literals. */
function inlined(sql: { text: string; values: unknown[] }): string {
  return sql.text.replace(/\$(\d+)/g, (_, n: string) => {
    const value = sql.values[Number(n) - 1];
    if (typeof value === 'number') return String(value);
    return `'${String(value).replaceAll("'", "''")}'`;
  });
}

const asOf = arg('as-of');
const bucket = arg('bucket', 'OVER_90');
if (!DATE.test(asOf)) throw new Error(`--as-of must be YYYY-MM-DD, not ${asOf}`);
const ageBucket = AGE_BUCKETS.find((b) => b === bucket);
if (ageBucket === undefined) throw new Error(`--bucket must be one of ${AGE_BUCKETS.join(', ')}`);

const sql = outstandingReportSql({ kind: 'all' }, { ageBucket }, asOf, { offset: 0, limit: 20 });
process.stdout.write(
  `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${inlined(sql.statement)};\n` +
    `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${inlined(sql.count)};\n`,
);
