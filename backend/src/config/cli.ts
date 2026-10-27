import type { z } from 'zod';
import {
  appEnv,
  databaseUrl,
  defineProcessConfig,
  isPrivilegedDatabaseKey,
  logLevel,
  origin,
} from './rules.js';

export const cliConfig = defineProcessConfig({
  process: 'cli',
  shape: {
    APP_ENV: appEnv,
    APP_ORIGIN: origin,
    DATABASE_URL: databaseUrl('po_app'),
    LOG_LEVEL: logLevel,
  },
  forbidden: (key) => key === 'MAINTENANCE_DATABASE_URL' || isPrivilegedDatabaseKey(key),
});

export type CliConfig = z.output<typeof cliConfig.schema>;
