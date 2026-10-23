import { z } from 'zod';
import { loadConfig } from '../config/load.js';
import { createLogger } from '../observability/logger.js';
import { deployMigrations } from './deploy.js';
import { provisionDatabase } from './provision.js';

// Minimal migrate config for steps 1 and 2. T027 adds the full migrate schema
// (production refusals, credential separation, bootstrap variables).
const migrateConfigSchema = z.object({
  OWNER_DATABASE_URL: z.url(),
  POSTGRES_PASSWORD: z.string().min(16),
  DB_OWNER_PASSWORD: z.string().min(16),
  DB_APP_PASSWORD: z.string().min(16),
  DB_MAINTENANCE_PASSWORD: z.string().min(16),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

async function main() {
  const config = loadConfig(migrateConfigSchema);
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
  logger.info('migrate complete');
}

main().catch((error: unknown) => {
  createLogger().fatal({ err: error }, 'migrate failed');
  process.exit(1);
});
