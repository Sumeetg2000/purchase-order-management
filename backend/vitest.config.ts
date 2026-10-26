import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Two projects: unit tests run without Docker; integration tests share one PostgreSQL
// container started by the global setup (research R19). Both load the suite-wide checks:
// no token-shaped value in any log line (SC-003), and every API error response in the
// standard shape with a matching correlation id (SC-002).
const suiteChecks = ['tests/support/log-capture.ts', 'tests/support/response-audit.ts'];
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
          setupFiles: suiteChecks,
        },
      },
      {
        test: {
          name: 'integration',
          // Contract tests need the database too (readiness), so they run here.
          include: ['tests/integration/**/*.test.ts', 'tests/contract/**/*.test.ts'],
          globalSetup: ['tests/support/global-setup.ts'],
          setupFiles: [...suiteChecks, 'tests/support/setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
