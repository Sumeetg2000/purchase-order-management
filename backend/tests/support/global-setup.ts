import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { deployMigrations } from '../../src/migrate/deploy.js';
import { provisionDatabase } from '../../src/migrate/provision.js';
import { POSTGRES_IMAGE, TEMPLATE_DATABASE, TEST_PASSWORDS, roleUrl } from './postgres.js';

let container: StartedPostgreSqlContainer | undefined;

/**
 * Starts PostgreSQL once per run and builds a migrated template database with the same
 * provisioning and migrations as production (research R19). Tests clone it.
 */
export default async function setup(project: TestProject) {
  container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withUsername('postgres')
    .withPassword(TEST_PASSWORDS.superuser)
    .withDatabase('postgres')
    .start();

  const connection = { host: container.getHost(), port: container.getPort() };

  await provisionDatabase({
    superuserUrl: roleUrl(connection, 'postgres', 'postgres'),
    databaseName: TEMPLATE_DATABASE,
    passwords: {
      owner: TEST_PASSWORDS.owner,
      app: TEST_PASSWORDS.app,
      maintenance: TEST_PASSWORDS.maintenance,
    },
  });
  await deployMigrations(roleUrl(connection, 'po_owner', TEMPLATE_DATABASE));

  // A template must have no open connections when it is cloned.
  const admin = new pg.Client({ connectionString: roleUrl(connection, 'postgres', 'postgres') });
  await admin.connect();
  await admin.query(
    `ALTER DATABASE ${TEMPLATE_DATABASE} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`,
  );
  await admin.end();

  project.provide('postgres', connection);

  return async () => {
    await container?.stop();
  };
}
