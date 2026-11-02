// Layering (constitution Principle XI): a route module calls services and never reaches
// the database or opens a transaction itself. Lints probe imports, in each place a route
// module may live, with the repository's own ESLint config.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { ESLint } from 'eslint';

const RULE = 'import-x/no-restricted-paths';
const root = fileURLToPath(new URL('../..', import.meta.url));
// Only the layering rule runs, so the probes need no type information, and their paths
// needn't exist on disk.
const eslint = new ESLint({
  cwd: root,
  ruleFilter: ({ ruleId }) => ruleId === RULE,
  overrideConfig: { languageOptions: { parserOptions: { projectService: false } } },
});

// Each place a route module may live, with the relative path from it to `backend/src/`.
const ROUTE_MODULES = [
  ['backend/src/health/routes.ts', '../'],
  ['backend/src/health/routes/probe.ts', '../../'],
  ['backend/src/health/probe.routes.ts', '../'],
];

/** The rule's messages for a route module at `filePath` made of the given import. */
async function routeImporting(filePath, statement) {
  const [result] = await eslint.lintText(`${statement}\nexport {};\n`, { filePath });
  return result.messages.filter((message) => message.ruleId === RULE);
}

describe('route modules never reach the database', () => {
  for (const [filePath, src] of ROUTE_MODULES) {
    for (const [what, statement] of [
      ['a repository', `import { createHealthRepository } from '${src}health/repository.js';`],
      ['the Prisma client module', `import { createPrismaClient } from '${src}db/client.js';`],
      ['the generated Prisma client', `import { Prisma } from '${src}generated/prisma/client.js';`],
      ['the transaction module', `import { withTransaction } from '${src}db/transaction.js';`],
    ]) {
      it(`${filePath} importing ${what} fails lint`, async () => {
        assert.equal((await routeImporting(filePath, statement)).length, 1);
      });
    }

    it(`${filePath} importing a service passes`, async () => {
      assert.deepEqual(
        await routeImporting(
          filePath,
          `import { createReadinessService } from '${src}health/service.js';`,
        ),
        [],
      );
    });
  }

  it('a service may open the transaction', async () => {
    const [result] = await eslint.lintText(
      "import { withTransaction } from '../db/transaction.js';\nexport {};\n",
      { filePath: 'backend/src/health/service.ts' },
    );
    assert.deepEqual(
      result.messages.filter((message) => message.ruleId === RULE),
      [],
    );
  });
});
