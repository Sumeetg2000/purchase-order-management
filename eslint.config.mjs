// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
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
