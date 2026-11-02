import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    reporters: ['default', 'json'],
    outputFile: {
      json: fileURLToPath(new URL('../../reports/vitest-contracts.json', import.meta.url)),
    },
    // Reported, without a floor yet.
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      reporter: ['text-summary', 'json-summary', 'lcov'],
      reportsDirectory: fileURLToPath(new URL('../../reports/coverage/contracts', import.meta.url)),
    },
  },
});
