// The load test's run record (specs/008-outstanding-report/research.md R7; owner decision
// 2026-11-26): a run fails on any 5xx or timeout, any reconciliation row, or an
// unexplained unused index; a timing over its target is recorded, not failed.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { failuresOf, renderRunRecord } from '../load/record.mjs';

const result = (extra = {}) => ({
  date: '2026-11-26',
  commit: 'abc1234',
  durationMs: 512_000,
  dataset: { orders: 10_000, vendors: 200, buyers: 20, approvers: 2, receipts: 9_100 },
  statusCounts: { 200: 30_000, 201: 25_000 },
  timeouts: 0,
  timings: {
    'report, Admin, page 1': { p95: 12, target: 200 },
    'vendor summary, Admin': { p95: 30, target: 300 },
  },
  reconciliationRows: 0,
  indexes: { ok: true, unexpected: [], expectedButUsed: [], unexplained: [] },
  ...extra,
});

describe('[NFR-PERF-04] the load run record', () => {
  it('[NFR-PERF-04] a clean run passes, and the record shows its numbers', () => {
    assert.deepEqual(failuresOf(result()), []);
    const text = renderRunRecord(result());
    for (const part of [
      '**Result: pass**',
      '2026-11-26',
      'abc1234',
      '8 min 32 s',
      '| 200 | 30,000 |',
      '| 201 | 25,000 |',
      '| report, Admin, page 1 | 12 ms | 200 ms | within |',
      '| vendor summary, Admin | 30 ms | 300 ms | within |',
      'Reconciliation: 0 rows',
      'Unused indexes: all expected',
    ]) {
      assert.ok(text.includes(part), `missing ${part}\n${text}`);
    }
  });

  it('[NFR-PERF-04] a 5xx or a timeout fails the run', () => {
    assert.deepEqual(failuresOf(result({ statusCounts: { 200: 10, 503: 2 } })), [
      '2 responses with a 5xx status',
    ]);
    assert.deepEqual(failuresOf(result({ timeouts: 1 })), ['1 request timed out']);
  });

  it('[NFR-PERF-04] a timing over its target is recorded, not failed', () => {
    const slow = result({ timings: { 'report, Admin, page 1': { p95: 250, target: 200 } } });
    assert.deepEqual(failuresOf(slow), []);
    assert.ok(renderRunRecord(slow).includes('| report, Admin, page 1 | 250 ms | 200 ms | over |'));
  });

  it('[NFR-PERF-04] reconciliation rows or an unexplained unused index fail the run', () => {
    assert.deepEqual(failuresOf(result({ reconciliationRows: 3 })), [
      'reconciliation returned 3 rows',
    ]);
    const indexes = { ok: false, unexpected: ['x_idx'], expectedButUsed: [], unexplained: [] };
    assert.deepEqual(failuresOf(result({ indexes })), [
      'unused index not in the expected list: x_idx',
    ]);
    const text = renderRunRecord(result({ indexes }));
    assert.ok(text.includes('**Result: fail**'));
    assert.ok(text.includes('x_idx'));
  });
});
