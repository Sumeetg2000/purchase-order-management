import type { ApiConfig } from '../../src/config/api.js';

/**
 * A complete, valid API config for tests that start the real API process, so a new
 * config key is added here once rather than in every test.
 */
export function testApiConfig(
  overrides: Partial<ApiConfig> & Pick<ApiConfig, 'DATABASE_URL'>,
): ApiConfig {
  return {
    APP_ENV: 'local',
    APP_ORIGIN: 'http://localhost:8080',
    DB_POOL_SIZE: 2,
    DB_TX_TIMEOUT_MS: 5_000,
    DB_TX_MAX_WAIT_MS: 2_000,
    HTTP_PORT: 0,
    METRICS_PORT: 0,
    LOG_LEVEL: 'error',
    SMTP_HOST: 'mailpit',
    SMTP_PORT: 1025,
    SMTP_SECURE: false,
    SMTP_USER: undefined,
    SMTP_PASSWORD: undefined,
    MAIL_FROM: 'noreply@example.local',
    SIGNUP_ALLOWED_DOMAINS: ['example.local'],
    // Fixed 32-byte test keys, base64url; never used outside tests.
    JWT_SIGNING_KEY: Buffer.alloc(32, 1).toString('base64url'),
    JWT_KEY_ID: 'test-1',
    CSRF_SECRET: Buffer.alloc(32, 2).toString('base64url'),
    ...overrides,
  };
}
