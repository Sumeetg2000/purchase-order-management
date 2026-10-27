// Layering (constitution Principle XI): a route module calls services and never reaches
// the database itself. Lints probe imports, as an area's routes.ts, with the repository's
// own ESLint config.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { ESLint } from 'eslint';

const RULE = 'import-x/no-restricted-paths';
const root = fileURLToPath(new URL('../..', import.meta.url));
const eslint = new ESLint({ cwd: root, ruleFilter: ({ ruleId }) => ruleId === RULE });

/** The rule's messages for a route module made of the given import. */
async function routeImporting(statement) {
  const [result] = await eslint.lintText(`${statement}\nexport {};\n`, {
    filePath: 'backend/src/health/routes.ts',
  });
  return result.messages.filter((message) => message.ruleId === RULE);
}

describe('route modules never reach the database', () => {
  for (const [what, statement] of [
    ['a repository', "import { createHealthRepository } from './repository.js';"],
    ['the Prisma client module', "import { createPrismaClient } from '../db/client.js';"],
    ['the generated Prisma client', "import { Prisma } from '../generated/prisma/client.js';"],
  ]) {
    it(`a route importing ${what} fails lint`, async () => {
      assert.equal((await routeImporting(statement)).length, 1);
    });
  }

  it('a route importing its service passes', async () => {
    assert.deepEqual(
      await routeImporting("import { createReadinessService } from './service.js';"),
      [],
    );
  });
});
