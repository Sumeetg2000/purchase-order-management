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
];

// Branching on error text is banned (ADR-0007): map errors by code in backend/src/db/errors.ts,
// the only file allowed to read a caught error's message.
const caughtErrorMessage = [
  {
    selector: "CatchClause MemberExpression[property.name='message']",
    message: "Do not read a caught error's message; map it by code in db/errors.ts (ADR-0007).",
  },
  {
    selector:
      "CallExpression[callee.property.name='catch'] MemberExpression[property.name='message']",
    message: "Do not read a caught error's message; map it by code in db/errors.ts (ADR-0007).",
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
    files: ['backend/src/db/errors.ts'],
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
