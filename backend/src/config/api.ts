import { z } from 'zod';
import {
  appEnv,
  databaseUrl,
  defineProcessConfig,
  envBoolean,
  isPrivilegedDatabaseKey,
  logLevel,
  optional,
  origin,
  port,
  positiveInt,
} from './rules.js';

export const apiConfig = defineProcessConfig({
  process: 'api',
  shape: {
    APP_ENV: appEnv,
    APP_ORIGIN: origin,
    DATABASE_URL: databaseUrl('po_app'),
    DB_POOL_SIZE: positiveInt,
    DB_TX_TIMEOUT_MS: positiveInt,
    DB_TX_MAX_WAIT_MS: positiveInt,
    HTTP_PORT: port,
    METRICS_PORT: port,
    LOG_LEVEL: logLevel,
    SMTP_HOST: z.string().min(1),
    SMTP_PORT: port,
    SMTP_SECURE: envBoolean,
    SMTP_USER: optional(z.string()),
    SMTP_PASSWORD: optional(z.string()),
    MAIL_FROM: z.email(),
  },
  forbidden: (key) => key === 'MAINTENANCE_DATABASE_URL' || isPrivilegedDatabaseKey(key),
  refine: (config, ctx) => {
    if (config.METRICS_PORT === config.HTTP_PORT) {
      ctx.addIssue({
        code: 'custom',
        path: ['METRICS_PORT'],
        message: 'must differ from HTTP_PORT',
      });
    }
    if (config.APP_ENV === 'production' && config.SMTP_HOST === 'mailpit') {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_HOST'],
        message: 'is the local test inbox, which production refuses',
      });
    }
  },
});

export type ApiConfig = z.output<typeof apiConfig.schema>;
