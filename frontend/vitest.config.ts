import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// Two projects: plain-TypeScript tests (build target, API client) run in Node; component
// tests (*.test.tsx) render into jsdom.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      reporters: ['default', 'json'],
      outputFile: {
        json: fileURLToPath(new URL('../reports/vitest-frontend.json', import.meta.url)),
      },
      projects: [
        {
          extends: true,
          test: { name: 'node', include: ['tests/**/*.test.ts'], environment: 'node' },
        },
        {
          extends: true,
          test: {
            name: 'components',
            include: ['tests/**/*.test.tsx'],
            environment: 'jsdom',
            setupFiles: ['tests/support/setup.ts'],
            // Real CSS modules, not Vitest's stand-in that answers any class name, so a
            // misspelt class fails here (styles/classes.ts).
            css: { include: [/\.module\.css$/] },
          },
        },
      ],
    },
  }),
);
