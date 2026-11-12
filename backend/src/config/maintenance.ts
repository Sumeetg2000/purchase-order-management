import {
  appEnv,
  databaseUrl,
  defineProcessConfig,
  isPrivilegedDatabaseKey,
  logLevel,
  positiveInt,
} from './rules.js';

export const maintenanceConfig = defineProcessConfig({
  process: 'maintenance',
  shape: {
    APP_ENV: appEnv,
    MAINTENANCE_DATABASE_URL: databaseUrl('po_maintenance'),
    LOG_LEVEL: logLevel,
    PURGE_INTERVAL_HOURS: positiveInt,
  },
  forbidden: (key) => key === 'DATABASE_URL' || isPrivilegedDatabaseKey(key),
});
