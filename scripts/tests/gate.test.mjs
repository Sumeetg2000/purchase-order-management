// The local gate (scripts/gate.sh; owner, 2026-11-26): each check in turn, stopping at the
// first that fails with a non-zero status, so no failure can be hidden. Run here with stub
// npm, git and docker commands on the PATH that record their calls and fail on request.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Runs the gate with stubs that fail when their arguments contain `failOn`. */
function gate(failOn, env = {}) {
  const bin = mkdtempSync(join(tmpdir(), 'gate-stubs-'));
  const calls = join(bin, 'calls.log');
  writeFileSync(calls, '');
  for (const command of ['npm', 'git', 'docker']) {
    const stub = join(bin, command);
    writeFileSync(
      stub,
      `#!/usr/bin/env bash\necho "${command} $*" >> "${calls}"\n` +
        `if [[ -n "$GATE_FAIL_ON" && "${command} $*" == *"$GATE_FAIL_ON"* ]]; then exit 3; fi\n` +
        `echo "${command} ok"\n`,
    );
    chmodSync(stub, 0o755);
  }
  const result = spawnSync('scripts/gate.sh', [], {
    cwd: ROOT,
    encoding: 'utf8',
    // The caller's own GATE_SKIP_E2E never reaches the script: each test sets it or not.
    env: {
      ...process.env,
      GATE_SKIP_E2E: '0',
      GATE_LOG_DIR: join(bin, 'logs'),
      ...env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      GATE_FAIL_ON: failOn,
    },
  });
  return { ...result, calls: readFileSync(calls, 'utf8').trim().split('\n') };
}

describe('[NFR-OPS-02] the local gate stops at the first failing check', () => {
  it('[NFR-OPS-02] every check passing: each runs once, in order, gitleaks last', () => {
    const result = gate('');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, [
      'npm run -s check:ids',
      'npm run -s lint',
      'npm run -s typecheck',
      'npm test',
      'npm run e2e:local',
      'git fetch -q origin main',
      result.calls.at(-1),
    ]);
    assert.match(result.calls.at(-1) ?? '', /^docker run .*gitleaks:v8\.30\.1@sha256:/);
    assert.match(result.stdout, /gate: all checks passed/);
  });

  it('[NFR-OPS-02] a failing lint stops the gate there, with a non-zero status', () => {
    const result = gate('npm run -s lint');
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, ['npm run -s check:ids', 'npm run -s lint']);
    assert.match(result.stderr, /gate: lint FAILED/);
    assert.doesNotMatch(result.stdout, /all checks passed/);
  });

  it('[NFR-OPS-02] failing tests stop the gate before e2e and gitleaks', () => {
    const result = gate('npm test');
    assert.notEqual(result.status, 0);
    assert.equal(result.calls.at(-1), 'npm test');
    assert.match(result.stderr, /gate: test FAILED/);
  });

  it('[NFR-OPS-02] gitleaks finding a leak fails the gate', () => {
    const result = gate('docker run');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /gate: gitleaks FAILED/);
  });

  it('[NFR-OPS-02] GATE_SKIP_E2E leaves out only the local e2e stack', () => {
    const result = gate('', { GATE_SKIP_E2E: '1' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.calls.includes('npm run e2e:local'));
    assert.ok(result.calls.includes('npm test'));
  });

  it('[NFR-OPS-02] logs go to GATE_LOG_DIR, never over the real gate logs in reports/', () => {
    const real = join(ROOT, 'reports', 'gate-test.log');
    const before = existsSync(real) ? statSync(real).mtimeMs : undefined;
    const logs = mkdtempSync(join(tmpdir(), 'gate-logs-'));
    const result = gate('', { GATE_LOG_DIR: logs });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(logs, 'gate-test.log'), 'utf8'), 'npm ok\n');
    assert.equal(existsSync(real) ? statSync(real).mtimeMs : undefined, before);
  });
});
