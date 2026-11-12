import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { deployMigrations } from '../src/migrate/deploy.js';
import { provisionDatabase } from '../src/migrate/provision.js';
import { POSTGRES_IMAGE, TEST_PASSWORDS, roleUrl } from '../tests/support/postgres.js';
import {
  hotVendorId,
  seedVendorPlanData,
  vendorPlanQueries,
} from '../tests/plans/vendors-fixture.js';

// Writes the committed vendor query plans (research R11): a throwaway PostgreSQL, the
// production migrations, the plan test's data, then `EXPLAIN (COSTS OFF)` of every vendor
// list and history query with the values the API binds. Shape only (no costs, timings,
// rows or buffers), so a second run on the same data writes the same files and
// `git diff --exit-code docs/query-plans/vendors` fails only on a real plan change.

const OUT_DIR = new URL('../../docs/query-plans/vendors/', import.meta.url);
const DATABASE = 'po_plans';

async function main(): Promise<void> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withUsername('postgres')
    .withPassword(TEST_PASSWORDS.superuser)
    .withDatabase('postgres')
    .start();
  try {
    const connection = { host: container.getHost(), port: container.getPort() };
    await provisionDatabase({
      superuserUrl: roleUrl(connection, 'postgres', 'postgres'),
      databaseName: DATABASE,
      passwords: {
        owner: TEST_PASSWORDS.owner,
        app: TEST_PASSWORDS.app,
        maintenance: TEST_PASSWORDS.maintenance,
      },
    });
    await deployMigrations(roleUrl(connection, 'po_owner', DATABASE));

    const superuser = new pg.Client({
      connectionString: roleUrl(connection, 'postgres', DATABASE),
    });
    const app = new pg.Client({ connectionString: roleUrl(connection, 'po_app', DATABASE) });
    await superuser.connect();
    await app.connect();
    try {
      await seedVendorPlanData(superuser);
      const queries = vendorPlanQueries(await hotVendorId(app));

      await mkdir(OUT_DIR, { recursive: true });
      // A query that no longer exists leaves no stale plan behind.
      for (const file of await readdir(OUT_DIR)) {
        if (file.endsWith('.txt')) await rm(new URL(file, OUT_DIR));
      }
      for (const query of queries) {
        const { rows } = await app.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN (COSTS OFF) ${query.sql.text}`,
          query.sql.values,
        );
        const sql = query.sql.text.replace(/\s+/g, ' ').trim();
        const values = JSON.stringify(query.sql.values);
        const plan = rows.map((row) => row['QUERY PLAN']).join('\n');
        await writeFile(
          new URL(`${query.name}.txt`, OUT_DIR),
          `-- ${sql}\n-- values: ${values}\n\n${plan}\n`,
        );
      }
      console.info(`wrote ${String(queries.length)} plans to docs/query-plans/vendors`);
    } finally {
      await Promise.all([superuser.end(), app.end()]);
    }
  } finally {
    await container.stop();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
