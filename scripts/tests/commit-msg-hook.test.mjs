// The commit-msg hook runs commitlint on each message before the commit exists, so a
// message CI would reject (as a long "Failing run:" line once did) never gets pushed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const hooks = parse(readFileSync(join(ROOT, 'lefthook.yml'), 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'commit-msg-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Runs the hook's commitlint command the way lefthook does, with {1} the message file. */
function runHook(message) {
  const file = join(dir, 'COMMIT_EDITMSG');
  writeFileSync(file, message);
  const command = hooks['commit-msg'].commands.commitlint.run.replace('{1}', file);
  return spawnSync(command, { cwd: ROOT, shell: true, encoding: 'utf8' });
}

const LONG_FOOTER = `test: add failing tests

Some body text.

Failing run: node --test scripts/tests/security-headers.test.mjs scripts/tests/check-bundle-budget.test.mjs
`;

describe('[NFR-DEV-01] commit-msg hook', () => {
  it('[NFR-DEV-01] lefthook runs commitlint on the commit message', () => {
    assert.match(hooks['commit-msg']?.commands?.commitlint?.run ?? '', /commitlint --edit \{1\}/);
  });

  it('[NFR-DEV-01] it rejects the message that once broke CI (a long "Failing run:" footer)', () => {
    const result = runHook(LONG_FOOTER);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /footer-max-line-length/);
  });

  it('[NFR-DEV-01] it accepts a well-formed message', () => {
    const result = runHook('test: add a test\n\nSeen failing with\n  node --test x.test.mjs\n');
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
});
