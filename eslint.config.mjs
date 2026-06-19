import js from '@eslint/js'
import ts from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default ts.config(
  {
    ignores: [
      'dist/',
      'dist-test/',
      'dist-types/',
      'node_modules/',
      'eslint.config.mjs',
      'prettier.config.mjs',
      'playwright.config.ts',
      'tests/e2e/**',
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommendedTypeChecked,
  prettier,
  {
    languageOptions: {
      parserOptions: { project: ['./tsconfig.node.json', './tsconfig.web.json'] },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/require-await': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-control-regex': 'off',
    },
  },
  {
    files: ['src/**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
)
