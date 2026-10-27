import { runBootstrap } from '../bootstrap/run.js';
import { loadConfig } from '../config/load.js';
import { migrateConfig } from '../config/migrate.js';
import { createPrismaClient } from '../db/client.js';
import { ONE_SHOT } from '../db/one-shot.js';
import { createLogger } from '../observability/logger.js';
import { deployMigrations } from './deploy.js';
import { provisionDatabase } from './provision.js';

async function main() {
  const config = loadConfig(migrateConfig.schema);
  if (!config) return;
  const logger = createLogger(config.LOG_LEVEL);

  const owner = new URL(config.OWNER_DATABASE_URL);
  const superuser = new URL(config.OWNER_DATABASE_URL);
  superuser.username = 'postgres';
  superuser.password = config.POSTGRES_PASSWORD;

  logger.info({ step: 'db-init' }, 'provisioning roles and database');
  await provisionDatabase({
    superuserUrl: superuser.toString(),
    databaseName: owner.pathname.replace(/^\//, ''),
    passwords: {
      owner: config.DB_OWNER_PASSWORD,
      app: config.DB_APP_PASSWORD,
      maintenance: config.DB_MAINTENANCE_PASSWORD,
    },
  });

  logger.info({ step: 'migrate' }, 'applying migrations as po_owner');
  await deployMigrations(owner.toString());

  // Step 3 runs as po_app: creating the first administrator needs no more than the API's
  // own rights. A BootstrapError fails migrate, so api and maintenance never start.
  logger.info({ step: 'bootstrap' }, 'checking for an administrator');
  const prisma = createPrismaClient({
    url: config.DATABASE_URL,
    poolSize: 1,
    connectionTimeoutMs: ONE_SHOT.connectionTimeoutMs,
  });
  try {
    const result = await runBootstrap({
      prisma,
      email: config.BOOTSTRAP_ADMIN_EMAIL,
      name: config.BOOTSTRAP_ADMIN_NAME,
      appOrigin: config.APP_ORIGIN,
      logger,
    });
    if (result === 'skipped') {
      logger.info({ step: 'bootstrap' }, 'an administrator exists; nothing to do');
    }
  } finally {
    await prisma.$disconnect();
  }
  logger.info('migrate complete');
}

main().catch((error: unknown) => {
  createLogger().fatal({ err: error }, 'migrate failed');
  process.exit(1);
});
