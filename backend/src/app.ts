import type { Express } from 'express';
import type { Logger } from 'pino';
import { createAccessTokens } from './auth/access-token.js';
import { createAuthService } from './auth/service.js';
import type { ApiConfig } from './config/api.js';
import type { AppPrismaClient } from './db/client.js';
import { createTransactionRunner } from './db/transaction.js';
import { createApp } from './http/app.js';
import { productionRoutes, type RouteDependencies } from './http/routes/index.js';
import type { Clock } from './lib/clock.js';
import type { MailDispatcher } from './mail/dispatcher.js';
import type { Metrics } from './observability/metrics.js';
import { createRateLimiter } from './rate-limit/service.js';

// The API's Express app with every service wired from the config: what the server runs,
// and what integration tests run against.

export interface ApiAppOptions {
  config: ApiConfig;
  prisma: AppPrismaClient;
  clock: Clock;
  logger: Logger;
  mail: MailDispatcher;
  /** Every migration directory in this build; readiness needs each applied. */
  expectedMigrations: readonly string[];
  metrics?: Metrics;
}

/** The routes' dependencies from the config. */
export function routeDependencies(options: Omit<ApiAppOptions, 'metrics'>): RouteDependencies {
  const { config, prisma, clock } = options;
  return {
    prisma,
    expectedMigrations: options.expectedMigrations,
    logger: options.logger,
    mail: options.mail,
    clock,
    transactions: createTransactionRunner({
      prisma,
      timeoutMs: config.DB_TX_TIMEOUT_MS,
      maxWaitMs: config.DB_TX_MAX_WAIT_MS,
    }),
    rateLimiter: createRateLimiter({ prisma, clock }),
    accessTokens: createAccessTokens({
      signingKey: config.JWT_SIGNING_KEY,
      keyId: config.JWT_KEY_ID,
      clock,
    }),
    csrfSecret: config.CSRF_SECRET,
  };
}

export function createApiApp(options: ApiAppOptions): Express {
  const deps = routeDependencies(options);
  return createApp({
    logger: options.logger,
    appOrigin: options.config.APP_ORIGIN,
    ...(options.metrics ? { metrics: options.metrics } : {}),
    auth: {
      service: createAuthService({ prisma: deps.prisma, accessTokens: deps.accessTokens }),
      csrfSecret: deps.csrfSecret,
    },
    routes: productionRoutes(deps),
  });
}
