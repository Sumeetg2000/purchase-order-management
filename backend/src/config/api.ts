import { emailAddressSchema } from '@po/contracts';
import { z } from 'zod';
import {
  appEnv,
  databaseUrl,
  defineProcessConfig,
  domainList,
  envBoolean,
  isPrivilegedDatabaseKey,
  keyId,
  logLevel,
  optional,
  origin,
  port,
  positiveInt,
  signingSecret,
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
    MAIL_FROM: emailAddressSchema,
    SIGNUP_ALLOWED_DOMAINS: domainList,
    JWT_SIGNING_KEY: signingSecret,
    JWT_KEY_ID: keyId,
    CSRF_SECRET: signingSecret,
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
    // Credentials come as a pair: half of one would start the API and fail every mail.
    const hasUser = config.SMTP_USER !== undefined;
    if (hasUser !== (config.SMTP_PASSWORD !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: [hasUser ? 'SMTP_PASSWORD' : 'SMTP_USER'],
        message: 'SMTP_USER and SMTP_PASSWORD are set together or not at all',
      });
    }
    // One leaked secret must not give both: forging access tokens and CSRF tokens.
    if (config.CSRF_SECRET === config.JWT_SIGNING_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['CSRF_SECRET'],
        message: 'must differ from JWT_SIGNING_KEY',
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
