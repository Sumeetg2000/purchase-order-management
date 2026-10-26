// Commit subjects never carry requirement or task IDs; bodies may (ADR-0013).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import lint from '@commitlint/lint';
import load from '@commitlint/load';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const config = await load({}, { cwd: ROOT, file: 'commitlint.config.mjs' });

async function check(message) {
  const result = await lint(message, config.rules, {
    plugins: config.plugins,
    parserOpts: config.parserPreset?.parserOpts,
  });
  return { valid: result.valid, rules: result.errors.map((e) => e.name) };
}

describe('[NFR-DEV-01] commit subject rule', () => {
  it('[NFR-DEV-01] a requirement ID in the subject fails', async () => {
    assert.deepEqual(await check('feat(api): add the health route for NFR-OPS-01'), {
      valid: false,
      rules: ['subject-no-requirement-ids'],
    });
  });

  it('[NFR-DEV-01] a task ID in the subject fails', async () => {
    assert.deepEqual(await check('docs(specs): tick T072'), {
      valid: false,
      rules: ['subject-no-requirement-ids'],
    });
  });

  it('[NFR-DEV-01] IDs in the body are allowed', async () => {
    assert.deepEqual(
      await check('feat(api): add the health route\n\nCovers NFR-OPS-01 and T021.'),
      { valid: true, rules: [] },
    );
  });

  it('[NFR-DEV-01] tier names in the subject are not IDs', async () => {
    assert.equal((await check('feat(api): route above T1 to T2')).valid, true);
  });
});
