// The load test's unused-index check (specs/008-outstanding-report/research.md R8): every
// index the run never used must be in the committed expected-unused list with a one-line
// reason; anything else unused fails, and an expected entry that was used is reported so
// the list stays honest.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkIndexUsage } from '../load/indexes.mjs';

const usage = [
  { index: 'a_idx', scans: 12 },
  { index: 'b_idx', scans: 0 },
  { index: 'c_idx', scans: 0 },
  { index: 'd_idx', scans: 4 },
];

describe('[NFR-PERF-02] the unused-index check', () => {
  it('[NFR-PERF-02] passes when every unused index is expected, with its reason', () => {
    const result = checkIndexUsage(usage, [
      { index: 'b_idx', reason: 'purge job only' },
      { index: 'c_idx', reason: 'backs a uniqueness rule' },
    ]);
    assert.deepEqual(result, { ok: true, unexpected: [], expectedButUsed: [], unexplained: [] });
  });

  it('[NFR-PERF-02] fails on an unused index the list does not explain', () => {
    const result = checkIndexUsage(usage, [{ index: 'b_idx', reason: 'purge job only' }]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.unexpected, ['c_idx']);
  });

  it('[NFR-PERF-02] reports an expected entry that was used, without failing', () => {
    const result = checkIndexUsage(usage, [
      { index: 'b_idx', reason: 'purge job only' },
      { index: 'c_idx', reason: 'backs a uniqueness rule' },
      { index: 'd_idx', reason: 'thought unused' },
    ]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.expectedButUsed, ['d_idx']);
  });

  it('[NFR-PERF-02] an entry without a one-line reason fails', () => {
    for (const reason of ['', '  ', 'two\nlines']) {
      const result = checkIndexUsage(usage, [
        { index: 'b_idx', reason },
        { index: 'c_idx', reason: 'backs a uniqueness rule' },
      ]);
      assert.equal(result.ok, false, JSON.stringify(reason));
      assert.deepEqual(result.unexplained, ['b_idx']);
    }
  });
});
