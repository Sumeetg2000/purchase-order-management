// The requirement-ID ban (ADR-0013, research R20): IDs only in test names, never in
// source, comments or config.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkFiles, parseAllowlist } from '../check-requirement-ids.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/ids/', import.meta.url));

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path) : [relative(FIXTURES, path)];
  });
}

const files = listFiles(FIXTURES).filter((f) => f !== 'allowlist.txt');
const allowlist = parseAllowlist(readFileSync(join(FIXTURES, 'allowlist.txt'), 'utf8'));
const violations = checkFiles({ root: FIXTURES, files, allowlist });
const flagged = (path) => violations.filter((v) => v.path === path).map((v) => v.match);

describe('[NFR-DEV-01] requirement-ID ban', () => {
  it('[NFR-DEV-01] an ID in source code fails, with its file and line', () => {
    assert.deepEqual(flagged('src/leaky.ts'), ['NFR-OPS-01']);
    assert.equal(violations.find((v) => v.path === 'src/leaky.ts')?.line, 1);
  });

  it('[NFR-DEV-01] a task ID in a comment fails', () => {
    assert.deepEqual(flagged('src/commented.ts'), ['T072']);
  });

  it('[NFR-DEV-01] the same ID in a test file passes', () => {
    assert.deepEqual(flagged('src/leaky.test.ts'), []);
  });

  it('[NFR-DEV-01] an allowlisted false positive passes, and tier names are not flagged', () => {
    assert.deepEqual(flagged('src/models.ts'), []);
    assert.deepEqual(flagged('src/service.ts'), []);
  });

  it('[NFR-DEV-01] docs/ and specs/ are ignored', () => {
    assert.deepEqual(flagged('docs/notes.md'), []);
    assert.deepEqual(flagged('specs/tasks.md'), []);
  });

  it('[NFR-DEV-01] nothing else is flagged', () => {
    assert.deepEqual(violations.map((v) => v.path).sort(), ['src/commented.ts', 'src/leaky.ts']);
  });

  it('[NFR-DEV-01] an allowlist entry covers only its own token, and a directory entry covers the directory', () => {
    const narrow = parseAllowlist('src/models.ts T800\nsrc/vendor/\n');
    const found = checkFiles({
      root: FIXTURES,
      files: ['src/models.ts', 'src/leaky.ts'],
      allowlist: narrow,
    });
    assert.deepEqual(
      found.map((v) => v.match),
      ['NFR-OPS-01'],
    );
    const wide = parseAllowlist('src/\n');
    assert.deepEqual(checkFiles({ root: FIXTURES, files: ['src/leaky.ts'], allowlist: wide }), []);
  });
});
