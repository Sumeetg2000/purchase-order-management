// The breaking-change check's base handling. The comparison itself runs oasdiff in Docker
// and is exercised in CI; these cases exit before it.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const run = (base) =>
  spawnSync('scripts/contract-breaking.sh', [base], { cwd: ROOT, encoding: 'utf8' });

describe('[NFR-API-01] breaking-change check base', () => {
  it('[NFR-API-01] a base commit that is not in the history fails instead of skipping', () => {
    for (const base of ['0000000000000000000000000000000000000000', 'deadbeefdeadbeef', '']) {
      const result = run(base);
      assert.notEqual(result.status, 0, `base "${base}": ${result.stdout}`);
      assert.match(result.stderr, /base/);
    }
  });

  it('[NFR-API-01] a base commit without a committed document has nothing to compare', () => {
    const [first] = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).split('\n');
    const result = run(first);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /nothing to compare/);
  });
});
