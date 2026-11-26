// The load test's age shift (specs/008-outstanding-report/research.md R7, owner guards
// 2026-11-26): it refuses unless the target is the isolated po-load stack (project name and
// the db container's compose label), reads the superuser password only from the stack's
// throwaway env file and never puts it in a command line or output, and runs
// reconciliation right after the shift, failing on any row. Run with a stub docker.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { backdate } from '../load/backdate.mjs';

const PASSWORD = 'throwaway-superuser-secret';
const ORDER = '0192f0c4-1c2d-7e3f-8a4b-5c6d7e8f9a0c';

/**
 * A stub docker on PATH: `ps` prints `containers` ids; `exec` records its argv and whether
 * PGPASSWORD reached it, and prints `reconciliation` as the second exec's output.
 */
function stubDocker({ containers = ['db123'], reconciliation = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'backdate-stub-'));
  const calls = join(dir, 'calls.log');
  writeFileSync(calls, '');
  const stub = join(dir, 'docker');
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
echo "argv: $*" >> "${calls}"
if [[ "$1" == ps ]]; then
  printf '%b' "${containers.join('\\n')}"; [[ -n "${containers.join('')}" ]] && echo
  exit 0
fi
if [[ "$1" == exec ]]; then
  echo "pgpassword: \${PGPASSWORD:-}" >> "${calls}"
  cat >> "${calls}"
  n=$(grep -c '^argv: exec' "${calls}")
  if [[ "$n" == 2 ]]; then printf '%s' "${reconciliation}"; fi
  exit 0
fi
exit 9
`,
  );
  chmodSync(stub, 0o755);
  const envFile = join(dir, 'throwaway.env');
  writeFileSync(envFile, `APP_ENV=local\nPOSTGRES_PASSWORD=${PASSWORD}\nOTHER=x\n`);
  return { dir, calls: () => readFileSync(calls, 'utf8'), envFile };
}

async function run(stub, projectName = 'po-load') {
  const output = [];
  try {
    await backdate({
      projectName,
      envFile: stub.envFile,
      ages: [{ orderId: ORDER, days: 45 }],
      docker: join(stub.dir, 'docker'),
      log: (line) => output.push(line),
    });
    return { ok: true, output: output.join('\n') };
  } catch (error) {
    return { ok: false, error: String(error), output: output.join('\n') };
  }
}

describe('[NFR-PERF-02] the load test age shift', () => {
  it('[NFR-PERF-02] refuses any compose project but po-load, before touching docker', async () => {
    const stub = stubDocker();
    const result = await run(stub, 'po-e2e');
    assert.equal(result.ok, false);
    assert.match(result.error, /po-load/);
    assert.equal(stub.calls(), '');
  });

  it('[NFR-PERF-02] refuses unless exactly one db container carries the po-load label', async () => {
    for (const containers of [[], ['db1', 'db2']]) {
      const stub = stubDocker({ containers });
      const result = await run(stub);
      assert.equal(result.ok, false, containers.join());
      assert.match(stub.calls(), /label=com\.docker\.compose\.project=po-load/);
      assert.doesNotMatch(stub.calls(), /argv: exec/);
    }
  });

  it('[NFR-PERF-02] shifts as the superuser, the password from the env file only, never in argv or output', async () => {
    const stub = stubDocker();
    const result = await run(stub);
    assert.equal(result.ok, true, result.error);
    const calls = stub.calls();
    assert.match(calls, /pgpassword: throwaway-superuser-secret/);
    for (const line of calls.split('\n').filter((l) => l.startsWith('argv:'))) {
      assert.doesNotMatch(line, new RegExp(PASSWORD));
    }
    assert.doesNotMatch(result.output, new RegExp(PASSWORD));
    // One transaction with triggers off, the order's own times shifted by its days.
    assert.match(calls, /session_replication_role = replica/);
    assert.match(calls, new RegExp(`'${ORDER}'::uuid, 45`));
    assert.match(calls, /UPDATE purchase_orders/);
    assert.match(calls, /UPDATE goods_receipts/);
  });

  it('[NFR-PERF-02] runs reconciliation right after the shift and fails on any row', async () => {
    const clean = stubDocker();
    assert.equal((await run(clean)).ok, true);
    assert.equal((clean.calls().match(/^argv: exec/gm) ?? []).length, 2);
    const drifted = stubDocker({ reconciliation: 'INV-3|line 7|5|4' });
    const result = await run(drifted);
    assert.equal(result.ok, false);
    assert.match(result.error, /reconciliation/);
  });

  it('[NFR-PERF-02] refuses an age that is not a whole number of days, or an id that is not a uuid', async () => {
    for (const ages of [[{ orderId: ORDER, days: 1.5 }], [{ orderId: "x'; DROP", days: 3 }]]) {
      const stub = stubDocker();
      await assert.rejects(
        backdate({
          projectName: 'po-load',
          envFile: stub.envFile,
          ages,
          docker: join(stub.dir, 'docker'),
          log: () => {},
        }),
      );
      assert.doesNotMatch(stub.calls(), /argv: exec/);
    }
  });
});
