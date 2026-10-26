import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Two projects: unit tests run without Docker; integration tests share one PostgreSQL
// container started by the global setup (research R19).
export default defineConfig({
  test: {
    reporters: ['default', 'json'],
    outputFile: {
      json: fileURLToPath(new URL('../reports/vitest-backend.json', import.meta.url)),
    },
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          globalSetup: ['tests/support/global-setup.ts'],
          setupFiles: ['tests/support/setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
