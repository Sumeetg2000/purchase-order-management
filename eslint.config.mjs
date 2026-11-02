// @ts-check
import js from '@eslint/js';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import { defineConfig } from 'eslint/config';
import importX from 'eslint-plugin-import-x';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Banned everywhere. Later tasks append selectors here.
const restrictedSyntax = [
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: 'Raw HTML rendering is banned (ADR-0018).',
  },
  {
    selector: "JSXAttribute[name.name='confirmLabel'] Literal[value=/^\\s*(ok|yes)\\s*$/i]",
    message: 'A confirm button names its action ("Cancel order"), never "OK" or "Yes" (ADR-0018).',
  },
];

// Branching on error text is banned (ADR-0007): errors are mapped by code in
// backend/src/db/errors.ts, which (with its regression test pinning pg-pool's message) is
// the only place allowed to read an error's message. The rule targets `.message` on
// identifiers named like errors, wherever they come from (catch, .catch, error middleware).
const ERROR_NAME = '/^(e|err|error|cause|reason|ex|exception)$/';
const errorMessageRule =
  "Do not read an error's message; map it by code in db/errors.ts (ADR-0007).";
// The error identifier itself, or wrapped in a cast or non-null assertion.
const errorObject = `:matches([object.name=${ERROR_NAME}], [object.expression.name=${ERROR_NAME}])`;
const caughtErrorMessage = [
  {
    selector: `MemberExpression${errorObject}:matches([property.name='message'], [property.value='message'])`,
    message: errorMessageRule,
  },
];

/** Route modules (CLAUDE.md, Layering), and what the lint rule tells one that oversteps. */
const routeModules = {
  target: ['backend/src/*/routes.ts', 'backend/src/*/routes/**', 'backend/src/**/*.routes.ts'],
  message: 'Routes call services: services open the transaction, repositories run queries.',
};

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      'reports/**',
      '.specify/**',
      '.claude/**',
      'backend/src/generated/**',
      // Generated from the committed OpenAPI document by openapi-typescript.
      'frontend/src/api/schema.d.ts',
      // Declarations only, for TypeScript imports of these .mjs modules.
      'deploy/security-headers.d.mts',
      'scripts/dev-env.d.mts',
      // Inputs for the check scripts' tests, not code.
      'scripts/tests/fixtures/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      'no-restricted-syntax': ['error', ...restrictedSyntax, ...caughtErrorMessage],
    },
  },
  {
    files: ['backend/src/db/errors.ts', 'backend/tests/integration/db-error-shapes.test.ts'],
    rules: { 'no-restricted-syntax': ['error', ...restrictedSyntax] },
  },
  {
    files: ['frontend/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
    languageOptions: { globals: globals.browser },
  },
  // Accessibility of the JSX itself (ADR-0018), alongside axe on the rendered pages.
  { files: ['frontend/**/*.tsx'], ...jsxA11y.flatConfigs.recommended },
  // No import cycles anywhere in TypeScript: they break module load order (Zod's jitless
  // setting depends on it) and blur layer boundaries.
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'import-x': importX },
    settings: {
      // Without a parser for the files it follows, import-x can't read their imports and
      // silently finds no cycle.
      'import-x/parsers': { '@typescript-eslint/parser': ['.ts', '.tsx', '.mts', '.cts'] },
      'import-x/extensions': ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs'],
      'import-x/resolver-next': [createTypeScriptImportResolver({ alwaysTryTypes: true })],
    },
    rules: { 'import-x/no-cycle': 'error' },
  },
  // Layering (CLAUDE.md): an area's routes call its services; they never reach the
  // database or open a transaction. Only services call withTransaction, and only
  // repositories run queries. scripts/tests/layering.test.mjs probes it.
  {
    files: ['backend/src/**/*.ts'],
    rules: {
      'import-x/no-restricted-paths': [
        'error',
        {
          basePath: import.meta.dirname,
          // The plugin takes globs or plain paths in one zone's `from`, not both.
          zones: [
            {
              ...routeModules,
              from: ['backend/src/*/repository.ts', 'backend/src/generated/**'],
            },
            {
              ...routeModules,
              from: ['backend/src/db/client.ts', 'backend/src/db/transaction.ts'],
            },
          ],
        },
      ],
    },
  },
  {
    files: ['backend/**/*.ts', 'packages/**/*.ts', 'scripts/**/*.{js,mjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
);
