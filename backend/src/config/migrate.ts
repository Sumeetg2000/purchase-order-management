import { emailAddressSchema } from '@po/contracts';
import { z } from 'zod';
import {
  appEnv,
  databaseUrl,
  defineProcessConfig,
  envBoolean,
  logLevel,
  optional,
  origin,
  secret,
} from './rules.js';

const ROLE_PASSWORDS = ['DB_OWNER_PASSWORD', 'DB_APP_PASSWORD', 'DB_MAINTENANCE_PASSWORD'] as const;

// Provisioning sets each role's password from DB_*_PASSWORD, and the later steps log in
// with these URLs, so the two must agree.
const URL_PASSWORDS = [
  ['OWNER_DATABASE_URL', 'DB_OWNER_PASSWORD'],
  ['DATABASE_URL', 'DB_APP_PASSWORD'],
] as const;

export const migrateConfig = defineProcessConfig({
  process: 'migrate',
  shape: {
    APP_ENV: appEnv,
    APP_ORIGIN: origin,
    POSTGRES_PASSWORD: secret,
    DB_OWNER_PASSWORD: secret,
    DB_APP_PASSWORD: secret,
    DB_MAINTENANCE_PASSWORD: secret,
    OWNER_DATABASE_URL: databaseUrl('po_owner'),
    DATABASE_URL: databaseUrl('po_app'),
    LOG_LEVEL: logLevel,
    SEED_DEMO_DATA: envBoolean,
    // Required only when no admin exists yet; the bootstrap checks that at run time.
    BOOTSTRAP_ADMIN_EMAIL: optional(emailAddressSchema.transform((v) => v.toLowerCase())),
    BOOTSTRAP_ADMIN_NAME: optional(z.string().trim().min(1).max(100)),
  },
  forbidden: (key) => key === 'MAINTENANCE_DATABASE_URL',
  refine: (config, ctx) => {
    const seen = new Map<string, string>();
    for (const key of ROLE_PASSWORDS) {
      const earlier = seen.get(config[key]);
      if (earlier) {
        ctx.addIssue({ code: 'custom', path: [key], message: `must differ from ${earlier}` });
      }
      seen.set(config[key], key);
    }
    for (const [urlKey, passwordKey] of URL_PASSWORDS) {
      if (decodeURIComponent(new URL(config[urlKey]).password) !== config[passwordKey]) {
        ctx.addIssue({
          code: 'custom',
          path: [urlKey],
          message: `password must equal ${passwordKey}`,
        });
      }
    }
    if (config.APP_ENV === 'production' && config.SEED_DEMO_DATA) {
      ctx.addIssue({
        code: 'custom',
        path: ['SEED_DEMO_DATA'],
        message: 'must be false in production',
      });
    }
  },
});

export type MigrateConfig = z.output<typeof migrateConfig.schema>;
