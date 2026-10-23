import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    reporters: ['default', 'json'],
    outputFile: {
      json: fileURLToPath(new URL('../../reports/vitest-api.json', import.meta.url)),
    },
  },
});
