// The node:test JSON reporter feeds the script tests into the traceability check.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Inside a node:test run, NODE_TEST_CONTEXT makes a nested `node --test` report to its
// parent instead of through the reporter, so the child runs without it.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;

describe('[NFR-DEV-01] node:test JSON reporter', () => {
  it('[NFR-DEV-01] reports every test with its describe titles and status, and a skipped suite as skipped', () => {
    const run = spawnSync(
      process.execPath,
      [
        '--test',
        '--test-reporter=./scripts/node-test-reporter.mjs',
        'scripts/tests/fixtures/reporter/sample.fixture.mjs',
      ],
      { cwd: ROOT, env, encoding: 'utf8' },
    );
    const report = JSON.parse(run.stdout);
    assert.deepEqual(
      report.testResults[0].assertionResults.map((t) => [t.fullName, t.status]),
      [
        ['[NFR-DEV-01] outer inner passes', 'passed'],
        ['[NFR-DEV-01] outer fails', 'failed'],
        ['[NFR-DEV-01] outer is skipped', 'skipped'],
        ['top level', 'passed'],
        ['[NFR-DEV-01] skipped suite', 'skipped'],
      ],
    );
  });
});
