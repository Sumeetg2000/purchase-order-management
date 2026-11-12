// Generated files keep their generator's formatting: CI regenerates them and compares byte
// for byte. Prettier reads .prettierignore only from the directory it runs in, so a run
// from frontend/ must skip the generated API types too, not only a run from the root.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const GENERATED = 'frontend/src/api/schema.d.ts';

/** prettier --check of one file, run from `cwd`; exit 0 when ignored (or already formatted). */
function check(cwd, file) {
  return spawnSync('npx', ['--no-install', 'prettier', '--check', file], {
    cwd: `${ROOT}${cwd}`,
    encoding: 'utf8',
  }).status;
}

describe('[NFR-DEV-01] prettier leaves generated files alone', () => {
  it('[NFR-DEV-01] a run from the root skips the generated API types', () => {
    assert.equal(check('', GENERATED), 0);
  });

  it('[NFR-DEV-01] a run from frontend/ skips them too', () => {
    assert.equal(check('frontend', GENERATED.replace('frontend/', '')), 0);
  });
});
