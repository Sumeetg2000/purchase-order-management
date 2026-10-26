import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['tests/**/*.test.{ts,tsx}'],
      reporters: ['default', 'json'],
      outputFile: {
        json: fileURLToPath(new URL('../reports/vitest-frontend.json', import.meta.url)),
      },
    },
  }),
);
